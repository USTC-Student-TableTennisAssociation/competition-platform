"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  type ProfileFormState,
  updateProfileActionForm,
} from "@/app/profile/actions";

type Props = {
  nickname: string;
  bio: string;
  avatarUrl: string;
};

const initialState: ProfileFormState = {};
const CROP_VIEW_SIZE = 280;
const OUTPUT_SIZE = 512;

type ImageMeta = {
  width: number;
  height: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function loadImageMeta(src: string): Promise<ImageMeta> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => reject(new Error("无法读取图片尺寸"));
    img.src = src;
  });
}

function toPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("裁剪结果生成失败"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

export default function ProfileEditorForm({ nickname, bio, avatarUrl }: Props) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    updateProfileActionForm,
    initialState,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragStateRef = useRef<{ x: number; y: number } | null>(null);

  const [clientError, setClientError] = useState<string | null>(null);
  const [localAvatarUrl, setLocalAvatarUrl] = useState<string>(avatarUrl);
  const [cropOpen, setCropOpen] = useState(false);
  const [sourceImageUrl, setSourceImageUrl] = useState<string | null>(null);
  const [imageMeta, setImageMeta] = useState<ImageMeta | null>(null);
  const [zoom, setZoom] = useState(1);
  const [centerX, setCenterX] = useState(0);
  const [centerY, setCenterY] = useState(0);

  useEffect(() => {
    if (!state.success) return;
    router.refresh();
  }, [state.success, router]);

  useEffect(() => {
    setLocalAvatarUrl(avatarUrl);
  }, [avatarUrl]);

  const clampCenter = (nextX: number, nextY: number, nextZoom = zoom) => {
    if (!imageMeta) {
      return { x: nextX, y: nextY };
    }

    const cropSize = Math.min(imageMeta.width, imageMeta.height) / nextZoom;
    const half = cropSize / 2;

    return {
      x: clamp(nextX, half, imageMeta.width - half),
      y: clamp(nextY, half, imageMeta.height - half),
    };
  };

  const openCropper = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setClientError("请选择图片文件。");
      return;
    }

    setClientError(null);

    const objectUrl = URL.createObjectURL(file);
    try {
      const meta = await loadImageMeta(objectUrl);
      setSourceImageUrl(objectUrl);
      setImageMeta(meta);
      setZoom(1);
      setCenterX(meta.width / 2);
      setCenterY(meta.height / 2);
      setCropOpen(true);
    } catch {
      URL.revokeObjectURL(objectUrl);
      setClientError("图片读取失败，请更换文件后重试。");
    }
  };

  const closeCropper = () => {
    if (sourceImageUrl) {
      URL.revokeObjectURL(sourceImageUrl);
    }
    setCropOpen(false);
    setSourceImageUrl(null);
    setImageMeta(null);
    setZoom(1);
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    await openCropper(file);
  };

  const handleZoomChange = (value: number) => {
    const nextZoom = value;
    const clamped = clampCenter(centerX, centerY, nextZoom);
    setZoom(nextZoom);
    setCenterX(clamped.x);
    setCenterY(clamped.y);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragStateRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current || !imageMeta) return;
    event.preventDefault();

    const cropSize = Math.min(imageMeta.width, imageMeta.height) / zoom;
    const scale = CROP_VIEW_SIZE / cropSize;

    const dx = event.clientX - dragStateRef.current.x;
    const dy = event.clientY - dragStateRef.current.y;

    dragStateRef.current = { x: event.clientX, y: event.clientY };

    const nextX = centerX - dx / scale;
    const nextY = centerY - dy / scale;
    const clamped = clampCenter(nextX, nextY);
    setCenterX(clamped.x);
    setCenterY(clamped.y);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const applyCrop = async () => {
    if (!sourceImageUrl || !imageMeta || !fileInputRef.current) return;

    const img = new Image();
    img.src = sourceImageUrl;
    await img.decode();

    const cropSize = Math.min(imageMeta.width, imageMeta.height) / zoom;
    const half = cropSize / 2;

    const sx = clamp(centerX - half, 0, imageMeta.width - cropSize);
    const sy = clamp(centerY - half, 0, imageMeta.height - cropSize);

    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setClientError("裁剪失败，请重试。");
      return;
    }

    ctx.clearRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    ctx.save();
    ctx.beginPath();
    ctx.arc(OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(
      img,
      sx,
      sy,
      cropSize,
      cropSize,
      0,
      0,
      OUTPUT_SIZE,
      OUTPUT_SIZE,
    );
    ctx.restore();

    try {
      const blob = await toPngBlob(canvas);
      const croppedFile = new File([blob], `avatar-${Date.now()}.png`, {
        type: "image/png",
      });

      const dt = new DataTransfer();
      dt.items.add(croppedFile);
      fileInputRef.current.files = dt.files;

      const previewUrl = URL.createObjectURL(blob);
      setLocalAvatarUrl(previewUrl);
      setClientError(null);
      closeCropper();
    } catch {
      setClientError("裁剪失败，请重试。");
    }
  };

  return (
    <>
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="csrfToken" defaultValue="" />
        <div>
          <label
            htmlFor="nickname"
            className="mb-1 block text-sm text-slate-300"
          >
            昵称
          </label>
          <input
            id="nickname"
            name="nickname"
            defaultValue={nickname}
            className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100 outline-none ring-cyan-400/40 focus:ring"
          />
        </div>

        <div>
          <label htmlFor="avatar" className="mb-1 block text-sm text-slate-300">
            上传头像（可裁剪）
          </label>
          <input
            ref={fileInputRef}
            id="avatar"
            name="avatar"
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="block w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-200 file:mr-3 file:rounded-lg file:border-0 file:bg-cyan-500/20 file:px-3 file:py-1.5 file:text-cyan-100"
          />
          <p className="mt-1 text-xs text-slate-400">
            支持 PNG/JPG/WEBP/GIF，最大 2MB。选择图片后可按 GitHub
            风格进行圆形裁剪。
          </p>
        </div>

        {localAvatarUrl && (
          <div className="space-y-2">
            <p className="text-sm text-slate-300">头像预览</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={localAvatarUrl}
              alt="头像预览"
              className="h-16 w-16 rounded-full object-cover ring-1 ring-cyan-400/30"
            />
          </div>
        )}

        <div>
          <label htmlFor="bio" className="mb-1 block text-sm text-slate-300">
            个人描述
          </label>
          <textarea
            id="bio"
            name="bio"
            defaultValue={bio}
            rows={4}
            className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100 outline-none ring-cyan-400/40 focus:ring"
          />
        </div>

        {(clientError || state.error) && (
          <p className="text-sm text-rose-300">{clientError ?? state.error}</p>
        )}
        {state.success && (
          <p className="text-sm text-emerald-300">{state.success}</p>
        )}
        <button
          disabled={pending}
          className="rounded-xl bg-linear-to-r from-cyan-500 to-blue-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {pending ? "保存中..." : "保存资料"}
        </button>
      </form>

      {cropOpen && sourceImageUrl && imageMeta && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4">
          <div className="w-full max-w-xl rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-white">裁剪头像</h3>
            <p className="mt-1 text-xs text-slate-400">
              拖动图片调整位置，滚动缩放后应用裁剪。
            </p>

            <div className="mt-4 flex justify-center">
              <div
                className="relative cursor-move touch-none overflow-hidden rounded-xl border border-slate-700 bg-slate-950"
                style={{ width: CROP_VIEW_SIZE, height: CROP_VIEW_SIZE }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              >
                {(() => {
                  const cropSize =
                    Math.min(imageMeta.width, imageMeta.height) / zoom;
                  const scale = CROP_VIEW_SIZE / cropSize;
                  const left = CROP_VIEW_SIZE / 2 - centerX * scale;
                  const top = CROP_VIEW_SIZE / 2 - centerY * scale;

                  return (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={sourceImageUrl}
                      alt="裁剪预览"
                      draggable={false}
                      className="pointer-events-none absolute max-w-none select-none"
                      style={{
                        width: imageMeta.width * scale,
                        height: imageMeta.height * scale,
                        left,
                        top,
                      }}
                    />
                  );
                })()}

                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div
                    className="rounded-full border-2 border-white/80"
                    style={{
                      width: CROP_VIEW_SIZE,
                      height: CROP_VIEW_SIZE,
                      boxShadow: "0 0 0 9999px rgba(2, 6, 23, 0.65)",
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <label htmlFor="avatar-zoom" className="text-xs text-slate-300">
                缩放
              </label>
              <input
                id="avatar-zoom"
                type="range"
                min={1}
                max={3}
                step={0.01}
                value={zoom}
                onChange={(event) =>
                  handleZoomChange(Number(event.target.value))
                }
                className="w-full"
              />
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  closeCropper();
                  if (fileInputRef.current) {
                    fileInputRef.current.value = "";
                  }
                }}
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
              >
                取消
              </button>
              <button
                type="button"
                onClick={applyCrop}
                className="rounded-lg bg-linear-to-r from-cyan-500 to-blue-500 px-3 py-2 text-sm font-semibold text-white"
              >
                应用裁剪
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
