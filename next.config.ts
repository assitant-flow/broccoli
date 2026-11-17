import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["postgres"],
  webpack: (config) => {
    // instrumentation / server bundle：node 内置模块与驱动保持 external
    const externals = [
      "child_process", "node:child_process", "net", "tls", "crypto", "node:crypto",
      "stream", "os", "dns", "http", "https", "url", "zlib", "buffer", "events",
      "util", "node:util", "fs", "node:fs", "node:fs/promises", "fs/promises",
      "path", "node:path", "module", "node:module", "assert", "timers", "querystring",
      "string_decoder", "postgres",
    ];
    config.externals = [...(Array.isArray(config.externals) ? config.externals : []), ...externals];
    return config;
  },
};

export default nextConfig;
