// Vercel Serverless Function: mọi request /api/* được rewrite về đây (xem vercel.json).
// server/dist/vercel.js được build bởi `npm run build` (tsup) trước khi Vercel đóng gói function.
export { default } from '../server/dist/vercel.js';
