'use client'

import { useRef, useState } from 'react'
import { uploadPrizeImageAction } from '@/app/admin/supermarket/upload-image'
import { CSRF_FORM_FIELD } from '@/lib/csrf-constants'
import PrizeImage from './PrizeImage'

export default function PrizeImagePicker({ initialUrl = null, onBusyChange }: { initialUrl?: string | null; onBusyChange: (busy: boolean) => void }) {
  const [imageUrl, setImageUrl] = useState(initialUrl)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  async function upload(file: File | undefined) {
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setError('图片不能超过 2 MB。')
      if (input.current) input.current.value = ''
      return
    }
    setBusy(true)
    onBusyChange(true)
    setError(null)
    try {
      const data = new FormData()
      data.set('file', file)
      // Upload starts on file selection, before the form's submit injector runs.
      const response = await fetch('/api/csrf-token', { credentials: 'same-origin', cache: 'no-store' })
      const payload = response.ok ? await response.json() as { token?: string } : null
      const token = payload?.token
      if (!token) { setError('安全校验失败，请刷新页面后重试。'); return }
      data.set(CSRF_FORM_FIELD, token)
      const result = await uploadPrizeImageAction(data)
      if (result.imageUrl) setImageUrl(result.imageUrl)
      else setError(result.error ?? '图片上传失败。')
    } catch {
      setError('图片上传失败，请检查图片大小并重试。')
    } finally {
      setBusy(false)
      onBusyChange(false)
      if (input.current) input.current.value = ''
    }
  }
  return (
    <div className="space-y-3 sm:col-span-2">
      <input type="hidden" name="imageUrl" value={imageUrl ?? ''} />
      <p className="text-sm text-neutral-600">商品图片（可选）</p>
      <div className="max-w-sm overflow-hidden rounded-xl border border-slate-200"><PrizeImage imageUrl={imageUrl} name="商品图片预览" /></div>
      <div className="flex flex-wrap gap-2">
        <label className="text-sm text-slate-700">
          <span className="mb-1 block">{busy ? '正在上传…' : '上传 JPG / PNG / WebP，最大 2 MB'}</span>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(event) => void upload(event.target.files?.[0])} className="max-w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-slate-700" />
        </label>
      </div>
      <label className="block space-y-1 text-sm text-slate-600">或选择现有商品图
        <select value={imageUrl === '/supermarket/towel-design.png' || imageUrl === '/supermarket/plush-preview.svg' ? imageUrl : ''} disabled={busy} onChange={(event) => { if (event.target.value) setImageUrl(event.target.value) }} className="block w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-neutral-900">
          <option value="">选择图片…</option>
          <option value="/supermarket/towel-design.png">科大乒协毛巾设计图</option>
          <option value="/supermarket/plush-preview.svg">乒乓球毛绒挂件商品截图</option>
        </select>
      </label>
      {imageUrl ? <button type="button" disabled={busy} onClick={() => setImageUrl(null)} className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">移除图片</button> : null}
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    </div>
  )
}
