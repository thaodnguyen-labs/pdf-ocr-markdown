/**
 * Handles client-side uploads to Vercel Blob.
 * The browser uploads the PDF directly here (bypassing the 4.5 MB function body limit).
 */
import { handleUpload } from '@vercel/blob/client';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    // Parse the raw JSON body manually (bodyParser is on by default)
    const body = await new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
      req.on('error', reject);
    });

    const response = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => ({
        allowedContentTypes: ['application/pdf'],
        maximumSizeInBytes: 200 * 1024 * 1024, // 200 MB
        addRandomSuffix: true,
      }),
      onUploadCompleted: async ({ blob }) => {
        console.log('PDF blob upload completed:', blob.url);
      },
    });

    return res.status(200).json(response);
  } catch (err) {
    console.error('blob-upload error:', err);
    return res.status(400).json({ error: err.message });
  }
}

export const config = { api: { bodyParser: false } };
