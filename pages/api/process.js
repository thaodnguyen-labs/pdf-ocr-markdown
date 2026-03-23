/**
 * Fetches a PDF from Vercel Blob, runs Mistral OCR,
 * stores extracted images back in Blob, returns markdown + image URLs.
 *
 * Accepts JSON body: { blobUrl, fileName, apiKey? }
 */
import { Mistral } from '@mistralai/mistralai';
import { put, del } from '@vercel/blob';

export const config = {
  api: {
    bodyParser: true,
    responseLimit: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { blobUrl, fileName, apiKey: clientKey } = req.body || {};
  const apiKey = clientKey || process.env.MISTRAL_API_KEY;

  if (!apiKey) return res.status(400).json({ error: 'Mistral API key is required.' });
  if (!blobUrl) return res.status(400).json({ error: 'No PDF blob URL provided.' });

  const baseName = (fileName || 'document').replace(/\.pdf$/i, '');
  const client = new Mistral({ apiKey });
  let uploadedFileId = null;

  try {
    // 1. Fetch PDF from Vercel Blob
    const pdfRes = await fetch(blobUrl);
    if (!pdfRes.ok) throw new Error(`Failed to fetch PDF from storage (${pdfRes.status})`);
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

    // 2. Upload PDF to Mistral
    const fileBlob = new Blob([pdfBuffer], { type: 'application/pdf' });
    const fileObj = new File([fileBlob], `${baseName}.pdf`, { type: 'application/pdf' });

    const uploaded = await client.files.upload({ file: fileObj, purpose: 'ocr' });
    uploadedFileId = uploaded.id;

    // 3. Get signed URL & run OCR
    const signedUrl = await client.files.getSignedUrl({ fileId: uploadedFileId });
    const ocrResponse = await client.ocr.process({
      model: 'mistral-ocr-latest',
      document: { type: 'document_url', documentUrl: signedUrl.url },
      includeImageBase64: true,
    });

    // 4. Process pages — store images in Vercel Blob
    const images = []; // { name, url }
    let fullMarkdown = '';
    const pageSep = '\n\n---\n\n';

    for (let i = 0; i < ocrResponse.pages.length; i++) {
      const page = ocrResponse.pages[i];
      let content = page.markdown || '';

      if (page.images?.length) {
        for (const img of page.images) {
          if (img.imageBase64) {
            const imgNum = images.length + 1;
            const imgName = `${baseName}_img_${imgNum}.png`;
            const b64 = img.imageBase64.replace(/^data:[^;]+;base64,/, '');
            const imgBuffer = Buffer.from(b64, 'base64');

            const blobResult = await put(imgName, imgBuffer, {
              access: 'public',
              contentType: img.mimeType || 'image/png',
              addRandomSuffix: true,
            });

            images.push({ name: imgName, url: blobResult.url });
            if (img.id) content = content.replaceAll(img.id, imgName);
          }
        }
      }

      fullMarkdown += content;
      if (i < ocrResponse.pages.length - 1) fullMarkdown += pageSep;
    }

    // 5. Cleanup — delete PDF from blob & Mistral
    try { await del(blobUrl); } catch (_) {}
    try { await client.files.delete({ fileId: uploadedFileId }); } catch (_) {}

    return res.status(200).json({
      markdown: fullMarkdown,
      images,           // [{ name, url }] — URLs, not base64
      fileName: baseName,
      pageCount: ocrResponse.pages.length,
    });

  } catch (err) {
    try { await del(blobUrl); } catch (_) {}
    try { if (uploadedFileId) await client.files.delete({ fileId: uploadedFileId }); } catch (_) {}
    console.error('OCR Error:', err);
    return res.status(500).json({ error: err?.message || 'An unexpected error occurred.' });
  }
}
