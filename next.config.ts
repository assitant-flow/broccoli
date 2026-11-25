import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["postgres"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  webpack: (config) => {
    // instrumentation / server bundle：node 内置模块与驱动保持 external
    const externals = [
      "child_process", "node:child_process", "net", "tls", "crypto", "node:crypto",
      "stream", "os", "dns", "http", "https", "url", "zlib", "buffer", "events",
      "util", "node:util", "fs", "node:fs", "node:fs/promises", "fs/promises",
      "path", "node:path", "module", "node:module", "assert", "timers", "querystring",
      "string_decoder", "postgres",
      "node:net", "node:tls", "node:http", "node:https", "node:os", "node:dns",
      "node:url", "node:zlib", "node:buffer", "node:events", "node:assert",
      "node:timers", "node:querystring", "node:string_decoder", "node:stream",
      "node:fs/promises",
    ];
    config.externals = [...(Array.isArray(config.externals) ? config.externals : []), ...externals];
    return config;
  },
};

export default nextConfig;
