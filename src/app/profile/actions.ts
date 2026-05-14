'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { getCurrentUser } from '@/lib/auth'
import { validateCsrfToken } from '@/lib/csrf'

export type ProfileFormState = {
  error?: string
  success?: string
}

const MAX_AVATAR_BYTES = 2 * 1024 * 1024

function extensionFromMimeType(type: string) {
  if (type === 'image/png') return '.png'
  if (type === 'image/jpeg') return '.jpg'
  if (type === 'image/webp') return '.webp'
  if (type === 'image/gif') return '.gif'
  return ''
}

function hasImageMagicBytes(type: string, buffer: Buffer) {
  if (type === 'image/png') {
    if (buffer.length < 8) return false
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    )
  }

  if (type === 'image/jpeg') {
    if (buffer.length < 3) return false
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  }

  if (type === 'image/gif') {
    if (buffer.length < 6) return false
    const signature = buffer.subarray(0, 6).toString('ascii')
    return signature === 'GIF87a' || signature === 'GIF89a'
  }

  if (type === 'image/webp') {
    if (buffer.length < 12) return false
    return (
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  }

  return false
}

let cloudinaryConfigured = false
let cloudinaryClientPromise: Promise<(typeof import('cloudinary'))['v2']> | null = null

function getCloudinaryCloudName() {
  return process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
}

async function getCloudinaryClient() {
  if (cloudinaryClientPromise) {
    return cloudinaryClientPromise
  }

  cloudinaryClientPromise = import('cloudinary').then(({ v2 }) => {
    const cloudName = getCloudinaryCloudName()
    const apiKey = process.env.CLOUDINARY_API_KEY
    const apiSecret = process.env.CLOUDINARY_API_SECRET

    if (!cloudName || !apiKey || !apiSecret) {
      throw new Error('Cloudinary 环境变量缺失。请配置 NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME、CLOUDINARY_API_KEY、CLOUDINARY_API_SECRET。')
    }

    if (!cloudinaryConfigured) {
      v2.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
      })
      cloudinaryConfigured = true
    }

    return v2
  })

  return cloudinaryClientPromise
}

function extractCloudinaryPublicId(url: string, cloudName: string) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'res.cloudinary.com') {
      return null
    }

    const pathSegments = decodeURIComponent(parsed.pathname).split('/').filter(Boolean)
    if (pathSegments[0] !== cloudName) {
      return null
    }

    const uploadIndex = pathSegments.findIndex((segment) => segment === 'upload')
    if (uploadIndex === -1) {
      return null
    }

    const afterUpload = pathSegments.slice(uploadIndex + 1)
    if (afterUpload.length === 0) {
      return null
    }

    const versionIndex = afterUpload.findIndex((segment) => /^v\d+$/.test(segment))
    const publicIdSegments = versionIndex >= 0 ? afterUpload.slice(versionIndex + 1) : afterUpload

    if (publicIdSegments.length === 0) {
      return null
    }

    const last = publicIdSegments[publicIdSegments.length - 1]
    publicIdSegments[publicIdSegments.length - 1] = last.replace(/\.[^.]+$/, '')

    return publicIdSegments.join('/')
  } catch {
    return null
  }
}

async function deleteCloudinaryAssetByUrl(url: string | null | undefined) {
  if (!url) {
    return
  }

  const cloudName = getCloudinaryCloudName()
  if (!cloudName) {
    return
  }

  const publicId = extractCloudinaryPublicId(url, cloudName)
  if (!publicId) {
    return
  }

  const cloudinary = await getCloudinaryClient()
  await cloudinary.uploader.destroy(publicId, {
    resource_type: 'image',
  })
}

async function uploadAvatarToCloudinary(fileBuffer: Buffer, userId: string) {
  const cloudinary = await getCloudinaryClient()

  const publicId = `${userId}-${randomUUID()}`

  return new Promise<string>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'avatars',
        public_id: publicId,
        overwrite: false,
        resource_type: 'image',
      },
      (error, result) => {
        if (error || !result?.secure_url) {
          reject(error ?? new Error('Cloudinary 未返回 secure_url'))
          return
        }

        resolve(result.secure_url)
      },
    )

    stream.end(fileBuffer)
  })
}

export async function updateProfileAction(_: ProfileFormState, formData: FormData): Promise<ProfileFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) {
    return { error: csrfError }
  }

  const currentUser = await getCurrentUser()
  if (!currentUser) {
    return { error: '请先登录后再修改资料。' }
  }

  const nickname = String(formData.get('nickname') ?? '').trim()
  const bio = String(formData.get('bio') ?? '').trim()
  const avatarFile = formData.get('avatar')

  if (!nickname) {
    return { error: '昵称不能为空。' }
  }

  if (nickname.length > 24) {
    return { error: '昵称不能超过 24 个字符。' }
  }

  if (bio.length > 160) {
    return { error: '个人描述不能超过 160 个字符。' }
  }

  let nextAvatarUrl: string | null | undefined
  const previousAvatarUrl = currentUser.avatarUrl
  let uploadedNewAvatar = false

  if (avatarFile instanceof File && avatarFile.size > 0) {
    const extension = extensionFromMimeType(avatarFile.type)
    if (!extension) {
      return { error: '头像文件必须是图片格式。' }
    }
    if (avatarFile.size > MAX_AVATAR_BYTES) {
      return { error: '头像大小不能超过 2MB。' }
    }

    const buffer = Buffer.from(await avatarFile.arrayBuffer())
    if (!hasImageMagicBytes(avatarFile.type, buffer)) {
      return { error: '头像文件内容与格式不匹配，请重新选择图片。' }
    }

    try {
      nextAvatarUrl = await uploadAvatarToCloudinary(buffer, currentUser.id)
      uploadedNewAvatar = true
    } catch (error) {
      console.error('头像上传到 Cloudinary 失败', error)
      return { error: '头像上传失败，请稍后重试。' }
    }
  }

  await prisma.user.update({
    where: { id: currentUser.id },
    data: {
      nickname,
      avatarUrl: nextAvatarUrl,
      bio: bio || null,
    },
  })

  const avatarChanged = typeof nextAvatarUrl !== 'undefined' && nextAvatarUrl !== previousAvatarUrl
  if (avatarChanged && uploadedNewAvatar) {
    try {
      await deleteCloudinaryAssetByUrl(previousAvatarUrl)
    } catch (error) {
      console.error('清理 Cloudinary 旧头像失败', error)
    }
  }

  revalidatePath('/profile')
  revalidatePath('/profile/edit')
  revalidatePath(`/profile/${currentUser.id}`)

  return { success: '资料已更新。' }
}

export async function updateProfileActionForm(state: ProfileFormState, formData: FormData) {
  return updateProfileAction(state, formData)
}
