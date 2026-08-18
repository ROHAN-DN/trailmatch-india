// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['jspdf', 'pdfjs-dist'],
}
module.exports = nextConfig
