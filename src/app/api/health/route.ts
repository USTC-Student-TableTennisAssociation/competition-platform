import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const revision = (await readFile(join(process.cwd(), 'REVISION'), 'utf8')).trim();
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid release revision.');
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: 'ok', revision }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ status: 'unhealthy' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
