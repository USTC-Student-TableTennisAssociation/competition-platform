'use client'

import { useRef, useState } from 'react'
import { ImageIcon, Maximize2, X } from 'lucide-react'

export default function PrizeImage({ imageUrl, name, illustration }: { imageUrl: string | null; name: string; illustration?: 'ball' | 'rubber' }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const usable = imageUrl && imageUrl !== failedUrl

  return (
    <div className={`relative flex aspect-square w-full items-center justify-center overflow-hidden ${illustration === 'ball' ? 'bg-[#1c2029]' : 'bg-[#151d2b]'}`}>
      {usable ? (
        <>
          <button type="button" onClick={() => dialog.current?.showModal()} className="h-full w-full focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-orange-400" aria-label={`查看${name}大图`}>
            {/* Validated uploaded or bundled images use their original aspect ratio. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt={name} className="h-full w-full object-contain p-2 sm:p-3" onError={() => setFailedUrl(imageUrl)} />
          </button>
          <span className="pointer-events-none absolute bottom-2 right-2 rounded-lg bg-[#101520]/90 p-1.5 text-slate-400"><Maximize2 className="h-3.5 w-3.5" aria-hidden /></span>
          <dialog ref={dialog} className="fixed inset-0 m-auto max-h-[90dvh] w-[min(90vw,720px)] overflow-auto rounded-2xl border border-white/[0.1] bg-[#101520] p-4 backdrop:bg-black/75" onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close() }}>
            <div className="mb-3 flex items-center justify-between gap-3 text-slate-100">
              <p className="font-medium">{name}</p>
              <button type="button" onClick={() => dialog.current?.close()} className="rounded-lg p-2 hover:bg-white/[0.08]" aria-label="关闭大图"><X className="h-5 w-5" /></button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt={name} className="mx-auto max-h-[72dvh] w-full object-contain" />
          </dialog>
        </>
      ) : <>
        {illustration ? <svg viewBox="0 0 240 240" className="h-full w-full" aria-hidden>
          {illustration === 'ball' ? <>
            <ellipse cx="120" cy="181" rx="71" ry="10" fill="#d8cbb9" opacity=".35" />
            <circle cx="86" cy="133" r="42" fill="#e9ad54" />
            <circle cx="159" cy="138" r="37" fill="#fffdf7" stroke="#e3d9c7" />
            <circle cx="124" cy="100" r="47" fill="#fffdf7" stroke="#e3d9c7" />
            <path d="M95 68c-18 16-24 40-13 60M149 68c18 17 23 41 12 62" fill="none" stroke="#eee7da" strokeWidth="2" />
            <text x="124" y="105" textAnchor="middle" fill="#738096" fontSize="12" fontFamily="sans-serif" letterSpacing="2">TTA</text>
            <text x="124" y="122" textAnchor="middle" fill="#738096" fontSize="8" fontFamily="sans-serif">40+</text>
          </> : <>
            <ellipse cx="120" cy="183" rx="68" ry="9" fill="#a5b6ca" opacity=".3" />
            <g transform="rotate(-12 111 117)"><rect x="52" y="53" width="115" height="128" rx="12" fill="#91acc9" /><rect x="58" y="59" width="103" height="116" rx="8" fill="#dbe5ef" /></g>
            <g transform="rotate(8 138 126)"><rect x="82" y="66" width="115" height="128" rx="12" fill="#245a96" /><rect x="88" y="72" width="103" height="116" rx="8" fill="#193c66" /><path d="M99 84h80M99 90h80M99 96h80" stroke="#315681" strokeWidth="2" /><text x="139" y="137" textAnchor="middle" fill="#d9e6f5" fontSize="14" fontFamily="sans-serif" letterSpacing="3">TTA</text><text x="139" y="154" textAnchor="middle" fill="#89a8cd" fontSize="8" fontFamily="sans-serif" letterSpacing="1">TABLE TENNIS</text></g>
          </>}
        </svg> : <ImageIcon className="h-8 w-8 text-slate-500" strokeWidth={1.3} aria-hidden />}
        <span className="absolute bottom-2 left-2 right-2 text-center text-[10px] text-slate-400 sm:text-[11px]">{imageUrl ? '图片暂时无法显示' : illustration ? '商品示意 · 实物照片待补' : '商品照片待补'}</span>
      </>}
    </div>
  )
}
