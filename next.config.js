/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next.js 15: serverExternalPackages（替代 experimental.serverComponentsExternalPackages）
  // Next.js 14 自动忽略不认识的 key，不会报错
  serverExternalPackages: ["@xenova/transformers", "onnxruntime-node"],

  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : []),
        /^onnxruntime-node$/,
      ];
    }
    return config;
  },
};

module.exports = nextConfig;
