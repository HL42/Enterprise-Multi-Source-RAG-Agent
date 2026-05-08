/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (isServer) {
      // onnxruntime-node 是 @xenova/transformers 的原生依赖
      // webpack 不能打包原生.node模块，必须标记为外部依赖
      // 正则形式确保匹配所有引用路径
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : []),
        /^onnxruntime-node$/,
      ];
    }
    return config;
  },
};

module.exports = nextConfig;
