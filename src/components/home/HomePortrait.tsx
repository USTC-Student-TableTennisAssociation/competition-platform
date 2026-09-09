"use client";

import { useState } from "react";
import { normalizeAvatarUrl } from "@/lib/utils";

export default function HomePortrait({ avatarUrl, nickname }: { avatarUrl: string | null; nickname: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const source = normalizeAvatarUrl(avatarUrl);
  return source && failedUrl !== source ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={source} alt={`${nickname}的头像`} fetchPriority="high" decoding="async" onError={() => setFailedUrl(source)} />
  ) : (
    <div className="home-portrait-fallback" role="img" aria-label={`${nickname}的默认头像`}>
      <span>{nickname.trim().slice(0, 1).toUpperCase() || "T"}</span>
    </div>
  );
}
