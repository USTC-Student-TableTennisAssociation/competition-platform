'use server'

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { validateCsrfToken } from '@/lib/csrf'
import { getAdminIdentity, isAdminReauthed } from '@/lib/server/admin/guard'
import { isLocalSupermarketDatabase, MAX_PRIZE_IMAGE_BYTES, prizeImageExtension } from '@/lib/server/supermarket/image-policy'

export async function uploadPrizeImageAction(formData: FormData): Promise<{ imageUrl?: string; error?: string }> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }
  const admin = await getAdminIdentity()
  if (!admin.ok) return { error: admin.error }
  if (!await isAdminReauthed(admin.userId)) return { error: '请先在控制台完成管理员二次验证。' }

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { error: '请选择一张图片。' }
  if (file.size > MAX_PRIZE_IMAGE_BYTES) return { error: '图片不能超过 2 MB。' }
  const bytes = Buffer.from(await file.arrayBuffer())
  const extension = prizeImageExtension(file.type, bytes)
  if (!extension) return { error: '请上传 JPG、PNG 或 WebP 图片。' }

  try {
    // Development assets stay on disk only for the project's named local DB.
    if (process.env.NODE_ENV === 'development' && isLocalSupermarketDatabase()) {
      const filename = `${randomUUID()}.${extension}`
      const folder = path.join(process.cwd(), 'public', 'uploads', 'supermarket')
      await mkdir(folder, { recursive: true })
      await writeFile(path.join(folder, filename), bytes, { flag: 'wx' })
      return { imageUrl: `/uploads/supermarket/${filename}` }
    }
    const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
    const apiKey = process.env.CLOUDINARY_API_KEY
    const apiSecret = process.env.CLOUDINARY_API_SECRET
    if (!cloudName || !apiKey || !apiSecret) return { error: '图片上传尚未配置，请先选择现有商品图。' }
    const { v2: cloudinary } = await import('cloudinary')
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true })
    const imageUrl = await new Promise<string>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'supermarket', public_id: randomUUID(), resource_type: 'image', overwrite: false },
        (error, result) => {
          if (error || !result?.secure_url) reject(error ?? new Error('Missing image URL'))
          else resolve(result.secure_url)
        },
      )
      stream.end(bytes)
    })
    return { imageUrl }
  } catch {
    return { error: '图片上传失败，请稍后重试。' }
  }
}
