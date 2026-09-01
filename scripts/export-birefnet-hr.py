#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = [
#   "torch==2.13.0",
#   "torchvision==0.28.0",
#   "timm==1.0.29",
#   "transformers==5.16.1",
#   "safetensors==0.8.0",
#   "einops==0.8.2",
#   "kornia==0.8.3",
#   "onnx==1.22.0",
#   "onnxruntime==1.29.0",
#   "onnxscript==0.7.1",
#   "huggingface-hub==1.29.0",
# ]
# ///
"""Export the official ZhengPeng7/BiRefNet_HR checkpoint to the ONNX file thumby pins.

thumby's local matting pass (ADR-0006, src/segment.ts) runs a pinned ONNX
segmenter through onnxruntime-node. For BiRefNet (general, 1024) an
onnx-community export exists to download. For BiRefNet_HR (2048) no ONNX
export exists anywhere (checked 2026-09), so this script produces it:

  1. download the official MIT checkpoint from Hugging Face,
  2. trace the model at its 2048x2048 input size, sigmoid on the final map,
  3. verify the fp32 ONNX graph against the PyTorch reference,
  4. convert to fp16 (keep_io_types) and verify again against the reference,
  5. print the sha-256 to pin in src/segment.ts.

Run:  uv run --locked --script scripts/export-birefnet-hr.py --out models/birefnet-hr-fp16.onnx

If the fp16 conversion fails verification the script keeps the fp32 file and
says so — the pin should then be updated to the fp32 file deliberately, never
to an unverified fp16 one.
"""

import argparse
import hashlib
import sys
from pathlib import Path

import numpy as np

MODEL_ID = "ZhengPeng7/BiRefNet_HR"
# Immutable Hugging Face commit. Never follow `main` — a floating tip can
# execute different remote code (trust_remote_code) and produce ONNX bytes
# that fail the runtime pin in src/segment.ts.
MODEL_REVISION = "a7a562f6fd16021180f2f4348f4de003a2d3d1e1"
CHECKPOINT_SHA256 = "9d678bafec0b0019fbb073b7fd02f05ede25dc4b15254f23b2fb0be333200c0d"
SIZE = 2048
OPSET = 18


def install_deform_conv_decomposition() -> None:
    """Replace torchvision's deform_conv2d with a tracer-friendly equivalent.

    The legacy ONNX exporter cannot trace `torchvision::deform_conv2d` (no
    symbolic for the TorchScript path), so the graph is built from standard
    ops instead: bilinear sampling through grid_sample, then a per-kernel
    weighted sum. The math must match torchvision exactly — `check_deform`
    below gates it numerically before any export is produced.
    """
    import torch
    import torch.nn.functional as F
    import torchvision.ops

    def deform_conv2d_torch(input, offset, weight, bias=None, stride=1, padding=0, dilation=1, mask=None):
        B, C, H, W = input.shape
        C_out, C_in, KH, KW = weight.shape
        assert C_in * 1 == C, "decomposition assumes ungrouped convolution"
        s = stride if isinstance(stride, (tuple, list)) else (stride, stride)
        p = padding if isinstance(padding, (tuple, list)) else (padding, padding)
        d = dilation if isinstance(dilation, (tuple, list)) else (dilation, dilation)
        H_out = (H + 2 * p[0] - d[0] * (KH - 1) - 1) // s[0] + 1
        W_out = (W + 2 * p[1] - d[1] * (KW - 1) - 1) // s[1] + 1
        G = offset.shape[1] // (2 * KH * KW)

        dev = input.device
        h_idx = torch.arange(H_out, device=dev, dtype=input.dtype) * s[0]
        w_idx = torch.arange(W_out, device=dev, dtype=input.dtype) * s[1]
        # Per kernel position: the un-offset sample coordinate grid,
        # (KH, KW, H_out, W_out), broadcast over the batch.
        base_y = (torch.arange(KH, device=dev, dtype=input.dtype) * d[0] - p[0]).view(KH, 1, 1, 1) + h_idx.view(1, 1, H_out, 1)
        base_x = (torch.arange(KW, device=dev, dtype=input.dtype) * d[1] - p[1]).view(1, KW, 1, 1) + w_idx.view(1, 1, 1, W_out)
        base_y = base_y.expand(KH, KW, H_out, W_out).reshape(1, KH * KW, H_out, W_out)
        base_x = base_x.expand(KH, KW, H_out, W_out).reshape(1, KH * KW, H_out, W_out)

        out = input.new_zeros(B, C_out, H_out, W_out)
        for g in range(G):
            off = offset[:, g * 2 * KH * KW : (g + 1) * 2 * KH * KW]
            off_y = off[:, 0::2].view(B, KH * KW, H_out, W_out)  # torchvision layout: (dy, dx) pairs
            off_x = off[:, 1::2].view(B, KH * KW, H_out, W_out)
            mod = None
            if mask is not None:
                mod = mask[:, g * KH * KW : (g + 1) * KH * KW].view(B, KH * KW, H_out, W_out)
            y = base_y + off_y
            x = base_x + off_x
            # grid_sample(align_corners=True) with n = 2*c/(size-1) - 1 samples
            # exactly DCNv2's floor/ceil bilinear interpolation on pixel coords.
            ny = 2 * y / (H - 1) - 1
            nx = 2 * x / (W - 1) - 1
            grid = torch.stack([nx, ny], dim=-1).view(B, KH * KW, H_out * W_out, 2)
            sampled = F.grid_sample(input, grid, mode="bilinear", padding_mode="zeros", align_corners=True)
            sampled = sampled.view(B, C, KH * KW, H_out, W_out)
            if mod is not None:
                sampled = sampled * mod.unsqueeze(1)
            # weights: (C_out, C, KH, KW) -> per-position (KH*KW, C_out, C)
            wk = weight.permute(2, 3, 0, 1).reshape(KH * KW, C_out, C)
            out = out + torch.einsum("bckhw,koc->bohw", sampled, wk)
        if bias is not None:
            out = out + bias.view(1, -1, 1, 1)
        return out

    def check_deform() -> None:
        torch.manual_seed(44)
        for (b, c, h, w, cout, kh, kw, s, p, d) in [
            (2, 4, 9, 11, 3, 3, 3, (1, 1), (1, 1), (1, 1)),
            (1, 3, 12, 8, 5, 3, 3, (2, 1), (2, 2), (1, 1)),
            (1, 2, 7, 7, 2, 1, 1, (1, 1), (0, 0), (1, 1)),
        ]:
            oh = (h + 2 * p[0] - d[0] * (kh - 1) - 1) // s[0] + 1
            ow = (w + 2 * p[1] - d[1] * (kw - 1) - 1) // s[1] + 1
            x = torch.randn(b, c, h, w)
            off = torch.randn(b, 2 * kh * kw, oh, ow) * 2.0
            wt = torch.randn(cout, c, kh, kw)
            bias = torch.randn(cout)
            mod = torch.rand(b, kh * kw, oh, ow) * 2
            ref = torchvision.ops.deform_conv2d(x, off, wt, bias, stride=s, padding=p, dilation=d, mask=mod)
            got = deform_conv2d_torch(x, off, wt, bias, stride=s, padding=p, dilation=d, mask=mod)
            err = float((ref - got).abs().max())
            assert err < 1e-4, f"deform_conv2d decomposition diverges ({err:.2e})"

    check_deform()
    torchvision.ops.deform_conv2d = deform_conv2d_torch


def install_trace_tidying() -> None:
    """Remove traced ops that stop CoreML from compiling the graph.

    `torch.roll` (the Swin cyclic shift) traces into an aten::roll that
    CoreML's compiler rejects outright — "Invalid shape for output feature
    'roll'" — and the provider then falls back to CPU-slow paths. The shift
    is exactly `cat(tail, head)` along the axis, so trace that instead. A zero
    shift stays the identity.
    """
    import torch

    def roll_decomposed(input, shifts, dims=None):
        if dims is None:
            dims = list(range(input.dim()))
        elif isinstance(dims, int):
            dims = [dims]
        shifts = [shifts] if isinstance(shifts, int) else list(shifts)
        out = input
        for dim, shift in zip(dims, shifts):
            size = out.shape[dim]
            s = shift % size
            if s == 0:
                continue
            tail = out.narrow(dim, size - s, s)
            head = out.narrow(dim, 0, size - s)
            out = torch.cat((tail, head), dim=dim)
        return out

    torch.roll = roll_decomposed


def tidy_swin_for_trace(model) -> None:
    """Freeze each BasicLayer's attention mask so it folds to a constant.

    Every BasicLayer rebuilds its attention mask per call from constants only
    (window/shift sizes and the fixed 2048 input resolution). Inside the trace
    that leaves live shape-op chains behind; building it once, eagerly, and
    reusing the same tensor lets the export record a constant. The mask math
    replicates the remote module's forward exactly (same window_partition
    layout), so the mask is identical — only its construction moves out of the
    graph. A changed mask would fail the numeric verification against the
    unpatched reference... which runs on the *patched* model, so the real gate
    is the fp16-vs-torch comparison below plus the visual check.
    """
    import torch

    seen_classes: set[type] = set()
    for module in model.modules():
        cls = type(module)
        if cls.__name__ != "BasicLayer" or cls in seen_classes:
            continue
        seen_classes.add(cls)

        def forward_cached(self, x, H, W):
            key = (H, W)
            masks = getattr(self, "_masks_by_hw", None)
            if masks is None:
                masks = {}
                self._masks_by_hw = masks
            if key not in masks:
                window_size = self.window_size
                shift_size = self.shift_size
                Hp = torch.ceil(torch.tensor(H) / window_size).to(torch.int64) * window_size
                Wp = torch.ceil(torch.tensor(W) / window_size).to(torch.int64) * window_size
                img_mask = torch.zeros((1, Hp, Wp, 1))
                h_slices = (
                    slice(0, -window_size),
                    slice(-window_size, -shift_size),
                    slice(-shift_size, None),
                )
                w_slices = (
                    slice(0, -window_size),
                    slice(-window_size, -shift_size),
                    slice(-shift_size, None),
                )
                cnt = 0
                for h in h_slices:
                    for w in w_slices:
                        img_mask[:, h, w, :] = cnt
                        cnt += 1
                B, Hp_, Wp_, C = img_mask.shape
                mask_windows = (
                    img_mask.view(B, Hp_ // window_size, window_size, Wp_ // window_size, window_size, C)
                    .permute(0, 1, 3, 2, 4, 5)
                    .contiguous()
                    .view(-1, window_size, window_size, C)
                    .view(-1, window_size * window_size)
                )
                attn_mask = mask_windows.unsqueeze(1) - mask_windows.unsqueeze(2)
                attn_mask = (
                    attn_mask.masked_fill(attn_mask != 0, float(-100.0))
                    .masked_fill(attn_mask == 0, float(0.0))
                    .to(x.dtype)
                )
                # A real buffer, not a plain attribute: buffers export as
                # graph initializers (constants), while plain tensor
                # attributes get re-traced as the op chain that built them.
                # One buffer per (H, W): the multi-scale 'cat' input path
                # runs every layer at two resolutions in a single pass.
                name = f"_attn_mask_{H}x{W}"
                if hasattr(self, name):
                    delattr(self, name)
                self.register_buffer(name, attn_mask, persistent=False)
                masks[key] = getattr(self, name)
            attn_mask = masks[key]
            for blk in self.blocks:
                blk.H, blk.W = H, W
                x = blk(x, attn_mask)
            if self.downsample is not None:
                x_down = self.downsample(x, H, W)
                Wh, Ww = (H + 1) // 2, (W + 1) // 2
                return x, H, W, x_down, Wh, Ww
            return x, H, W, x, H, W

        cls.forward = forward_cached

# Verification gates. fp32 must match the reference almost exactly; fp16 gets
# a wider envelope but must still agree on the binarised mask (what actually
# becomes alpha) and carry no NaNs.
FP32_MAX_ABS = 1e-4
FP16_MAX_ABS = 2e-2
FP16_MAX_MEAN = 2e-3
BINARIZE_AGREEMENT = 0.999


def load_pinned_checkpoint():
    """Download the immutable revision, verify the checkpoint bytes, then load.

    trust_remote_code is required by this architecture (custom BiRefNet class),
    but it only ever executes the code at MODEL_REVISION — never floating main.
    """
    from huggingface_hub import hf_hub_download
    from transformers import AutoModelForImageSegmentation

    weights = Path(
        hf_hub_download(MODEL_ID, "model.safetensors", revision=MODEL_REVISION),
    )
    actual = sha256_of(weights)
    if actual != CHECKPOINT_SHA256:
        raise SystemExit(
            f"checkpoint sha-256 is {actual}, not the pinned {CHECKPOINT_SHA256} "
            f"at {MODEL_ID}@{MODEL_REVISION} — refuse to execute remote code "
            f"or trace a different model"
        )
    print(f"checkpoint {MODEL_ID}@{MODEL_REVISION} sha-256 {actual}", flush=True)
    model = AutoModelForImageSegmentation.from_pretrained(
        MODEL_ID, revision=MODEL_REVISION, trust_remote_code=True
    )
    return model


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def reference_inputs(count: int = 2) -> list[np.ndarray]:
    """Inputs that mimic the real distribution better than pure noise: one
    gradient (smoothish, like background/plates) and one noise field (high
    frequency, like hair edges at 2048)."""
    rng = np.random.default_rng(44)
    grad = np.linspace(0.0, 1.0, SIZE, dtype=np.float32)
    inputs = [np.tile(grad, (SIZE, 1))[None, None].repeat(3, axis=1)]
    inputs.append(rng.random((1, 3, SIZE, SIZE), dtype=np.float32))
    return inputs[:count]


def fix_basic_layer_forwards(model) -> None:
    """Bind each BasicLayer a mask-free forward after the warm-up.

    The dynamo exporter traces with symbolic H and W, so the lazy cache check
    (`_mask_key != (H, W)`) can never hit under tracing and the whole mask
    construction lands in the graph as shape ops. After the eager warm-up has
    built each layer's mask buffer, rebind the instance's forward to read that
    fixed mask unconditionally — no branch, no construction, no shape ops.
    """
    import torch
    from types import MethodType

    def make_forward(masks):
        def forward_fixed(self, x, H, W):
            mask = masks[(int(H), int(W))]
            for blk in self.blocks:
                blk.H, blk.W = H, W
                x = blk(x, mask)
            if self.downsample is not None:
                x_down = self.downsample(x, H, W)
                Wh, Ww = (H + 1) // 2, (W + 1) // 2
                return x, H, W, x_down, Wh, Ww
            return x, H, W, x, H, W

        return forward_fixed

    for module in model.modules():
        if type(module).__name__ == "BasicLayer" and getattr(module, "_masks_by_hw", None):
            module.forward = MethodType(
                make_forward(dict(module._masks_by_hw)), module
            )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="models/birefnet-hr-fp16.onnx", type=Path)
    args = ap.parse_args()

    import torch

    torch.set_grad_enabled(False)
    torch.set_float32_matmul_precision("high")

    # Before any model code is imported: the graph must trace standard ops.
    install_deform_conv_decomposition()
    install_trace_tidying()

    out_fp16 = args.out
    out_fp32 = args.out.with_suffix(".fp32.onnx")

    print(f"downloading/loading {MODEL_ID}@{MODEL_REVISION}...", flush=True)
    model = load_pinned_checkpoint()
    model.eval()
    # The checkpoint stores Half weights; the graph is traced and verified in
    # fp32, and the fp16 artefact is a deliberate conversion afterwards.
    model = model.float()

    class SigmoidFinal(torch.nn.Module):
        """The exported graph: probabilities for the final refined map only.
        The supervision maps the decoder also emits are not needed downstream,
        and our maskPngFrom measures the range to decide sigmoid — exporting
        probabilities makes the ONNX behaviour explicit."""

        def __init__(self, inner):
            super().__init__()
            self.inner = inner

        def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
            preds = self.inner(pixel_values)
            return torch.sigmoid(preds[-1])

    # Reference outputs from the untouched checkpoint. The trace-tidying
    # patches below (roll identity, frozen Swin attention masks) are then
    # gated against these — a patch that changed the math fails here.
    import torch

    inputs = [torch.from_numpy(i) for i in reference_inputs()]
    plain = SigmoidFinal(model).eval()
    refs = [plain(i)[-1].numpy() for i in inputs]

    tidy_swin_for_trace(model)

    wrapper = SigmoidFinal(model).eval()

    # Warm the per-layer attention-mask caches eagerly: one forward pass at
    # the real input size builds and freezes every BasicLayer's mask, so the
    # subsequent trace records the masks as constants instead of re-tracing
    # the (CoreML-hostile) shape-op machinery that builds them.
    print("warm-up forward (freezes Swin attention masks)...", flush=True)
    with torch.no_grad():
        wrapper(inputs[0])
    fix_basic_layer_forwards(model)

    # Sanity: the tidied model must still reproduce the untouched checkpoint.
    tidy_err = max(float(np.max(np.abs(wrapper(i)[-1].numpy() - r))) for i, r in zip(inputs, refs))
    print(f"tidied model vs checkpoint: max abs diff {tidy_err:.2e}")
    if tidy_err > FP32_MAX_ABS:
        sys.exit(f"trace tidying changed the model's output ({tidy_err:.2e} > {FP32_MAX_ABS:.2e})")

    # --- trace ------------------------------------------------------------
    dummy = inputs[0]
    print(f"tracing at {SIZE}x{SIZE} (opset {OPSET})...", flush=True)
    torch.onnx.export(
        wrapper,
        (dummy,),
        str(out_fp32),
        input_names=["pixel_values"],
        output_names=["mask"],
        opset_version=OPSET,
        do_constant_folding=True,
    )

    # --- verify fp32 --------------------------------------------------------
    import onnxruntime as ort

    sess32 = ort.InferenceSession(str(out_fp32), providers=["CPUExecutionProvider"])

    worst32 = 0.0
    for i, ref in zip(inputs, refs):
        got = sess32.run(None, {"pixel_values": i.numpy()})[0]
        worst32 = max(worst32, float(np.max(np.abs(got - ref))))
        assert not np.isnan(got).any(), "fp32 ONNX output contains NaN"
    print(f"fp32 vs torch: max abs diff {worst32:.2e}")
    if worst32 > FP32_MAX_ABS:
        sys.exit(f"fp32 export diverges from the reference ({worst32:.2e} > {FP32_MAX_ABS:.2e})")

    # The fp16 conversion re-loads the whole graph; release everything else
    # first or the peak memory kills the process on smaller machines.
    del sess32, model, plain, wrapper, inputs, refs, dummy
    import gc

    gc.collect()

    # --- convert to fp16 ----------------------------------------------------
    from onnxruntime.transformers import float16 as ort_fp16

    print("converting to fp16 (keep_io_types)...", flush=True)
    import onnx

    # Type-sensitive ops stay fp32: the converter retypes ConstantOfShape's
    # output, which then mismatches the fp32 consumers around it and the
    # session refuses to load.
    fp32_model = onnx.load(str(out_fp32))
    fp16_model = ort_fp16.convert_float_to_float16(
        fp32_model,
        keep_io_types=True,
        op_block_list=["ConstantOfShape", "Pad"],
    )
    onnx.save(fp16_model, str(out_fp16))

    sess16 = ort.InferenceSession(str(out_fp16), providers=["CPUExecutionProvider"])

    # Recompute the reference fresh: the model was released before the
    # conversion to keep its peak memory survivable, so re-derive the
    # reference outputs from the official checkpoint here.
    model2 = load_pinned_checkpoint()
    model2.eval().float()
    torch.set_grad_enabled(False)

    worst16 = 0.0
    mean16 = 0.0
    bin_agree = 1.0
    for i in reference_inputs():
        ref = torch.sigmoid(model2(torch.from_numpy(i))[-1]).numpy()
        got = sess16.run(None, {"pixel_values": i})[0]
        assert not np.isnan(got).any(), "fp16 ONNX output contains NaN"
        worst16 = max(worst16, float(np.max(np.abs(got - ref))))
        mean16 = max(mean16, float(np.mean(np.abs(got - ref))))
        bin_agree = min(
            bin_agree,
            float(np.mean((got > 0.5) == (ref > 0.5))),
        )
    print(
        f"fp16 vs torch: max abs diff {worst16:.2e}, mean abs diff {mean16:.2e}, "
        f"binarised agreement {bin_agree:.5f}"
    )
    fp16_ok = (
        worst16 <= FP16_MAX_ABS
        and mean16 <= FP16_MAX_MEAN
        and bin_agree >= BINARIZE_AGREEMENT
    )
    if fp16_ok:
        out_fp32.unlink()
        final = out_fp16
    else:
        print(
            f"!! fp16 export FAILED verification (limits: max {FP16_MAX_ABS:.2e}, "
            f"mean {FP16_MAX_MEAN:.2e}, binarised {BINARIZE_AGREEMENT}) — "
            f"keeping the verified fp32 file; pin the fp32 file instead."
        )
        out_fp16.unlink()
        final = out_fp32

    size_mb = final.stat().st_size / (1 << 20)
    print(f"\nfile:   {final}")
    print(f"size:   {size_mb:.0f} MB")
    print(f"sha256: {sha256_of(final)}")


if __name__ == "__main__":
    main()
