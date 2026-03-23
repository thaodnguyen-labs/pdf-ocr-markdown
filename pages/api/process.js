import formidable from 'formidable';
import fs from 'fs';
import path from 'path';
import { Mistral } from '@mistralai/mistralai';

export const config = {
  api: {
    bodyParser: false,
    responseLimit: '50mb',
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const form = formidable({
    maxFileSize: 50 * 1024 * 1024, // 50MB
    keepExtensions: true,
  });

  let fields, files;
  try {
    [fields, files] = await form.parse(req);
  } catch (err) {
    return res.status(400).json({ error: 'Failed to parse upload: ' + err.message });
  }

  const apiKey = fields.apiKey?.[0] || process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'Mistral API key is required.' });
  }

  const pdfFile = files.pdf?.[0];
  if (!pdfFile) {
    return res.status(400).json({ error: 'No PDF file provided.' });
  }

  const originalName = pdfFile.originalFilename || 'document.pdf';
  const baseName = path.basename(originalName, '.pdf');

  let uploadedFileId = null;
  const client = new Mistral({ apiKey });

  try {
    // Read file buffer
    const fileBuffer = fs.readFileSync(pdfFile.filepath);

    // Upload PDF to Mistral
    const blob = new Blob([fileBuffer], { type: 'application/pdf' });
    const fileObj = new File([blob], originalName, { type: 'application/pdf' });

    const uploaded = await client.files.upload({
      file: fileObj,
      purpose: 'ocr',
    });
    uploadedFileId = uploaded.id;

    // Get signed URL
    const signedUrlResponse = await client.files.getSignedUrl({
      fileId: uploadedFileId,
    });

    // Run OCR
    const ocrResponse = await client.ocr.process({
      model: 'mistral-ocr-latest',
      document: {
        type: 'document_url',
        documentUrl: signedUrlResponse.url,
      },
      includeImageBase64: true,
    });

    // --- Build markdown + collect images ---
    const images = [];
    let fullMarkdown = '';
    const pageSeparator = '\n\n---\n\n';

    for (let pageIdx = 0; pageIdx < ocrResponse.pages.length; pageIdx++) {
      const page = ocrResponse.pages[pageIdx];
      let pageContent = page.markdown || '';

      // Extract embedded images
      if (page.images && page.images.length > 0) {
        for (const img of page.images) {
          if (img.imageBase64) {
            const imgNum = images.length + 1;
            const imgName = `${baseName}_img_${imgNum}.png`;
            images.push({
              name: imgName,
              base64: img.imageBase64,
              mimeType: img.mimeType || 'image/png',
            });
            // Replace Mistral's internal image ref with our filename
            if (img.id) {
              pageContent = pageContent.replaceAll(img.id, imgName);
            }
          }
        }
      }

      fullMarkdown += pageContent;
      if (pageIdx < ocrResponse.pages.length - 1) {
        fullMarkdown += pageSeparator;
      }
    }

    // Clean up temp file
    try { fs.unlinkSync(pdfFile.filepath); } catch (_) {}

    // Delete from Mistral storage
    try { await client.files.delete({ fileId: uploadedFileId }); } catch (_) {}

    return res.status(200).json({
      markdown: fullMarkdown,
      images,
      fileName: baseName,
      pageCount: ocrResponse.pages.length,
    });

  } catch (err) {
    // Clean up on error
    try { if (pdfFile.filepath) fs.unlinkSync(pdfFile.filepath); } catch (_) {}
    try { if (uploadedFileId) await client.files.delete({ fileId: uploadedFileId }); } catch (_) {}

    console.error('OCR Error:', err);
    return res.status(500).json({
      error: err?.message || 'An unexpected error occurred during OCR processing.',
    });
  }
}
