import { useState, useRef, useEffect, useCallback } from 'react';
import Head from 'next/head';
import { upload } from '@vercel/blob/client';
import JSZip from 'jszip';

export default function Home() {
  const [file, setFile] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [serverHasKey, setServerHasKey] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState('idle'); // idle | uploading | processing | done | error
  const [uploadProgress, setUploadProgress] = useState(0);
  const [logs, setLogs] = useState([]);
  const [result, setResult] = useState(null); // { markdown, images:[{name,url}], fileName, pageCount }
  const [activeTab, setActiveTab] = useState('preview');
  const [error, setError] = useState('');
  const fileInputRef = useRef(null);
  const logsEndRef = useRef(null);

  useEffect(() => {
    fetch('/api/check-api-key')
      .then(r => r.json())
      .then(d => setServerHasKey(d.hasKey))
      .catch(() => {});
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = useCallback((msg, type = 'info') => {
    setLogs(prev => [...prev, { msg, type, time: new Date().toLocaleTimeString() }]);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped?.type === 'application/pdf') {
      setFile(dropped);
      setError('');
    } else {
      setError('Please drop a PDF file.');
    }
  }, []);

  const handleFileChange = (e) => {
    const chosen = e.target.files[0];
    if (chosen) { setFile(chosen); setError(''); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) return setError('Please select a PDF file.');
    if (!serverHasKey && !apiKey.trim()) return setError('Please enter your Mistral API key.');

    setStatus('uploading');
    setUploadProgress(0);
    setLogs([]);
    setResult(null);
    setError('');

    let blobUrl = null;

    try {
      // ── Step 1: Upload PDF directly to Vercel Blob (no 4.5 MB limit) ──
      addLog(`📤 Uploading "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB) to storage…`);

      const blobResult = await upload(file.name, file, {
        access: 'public',
        handleUploadUrl: '/api/blob-upload',
        onUploadProgress: ({ percentage }) => {
          setUploadProgress(percentage);
        },
      });
      blobUrl = blobResult.url;
      addLog('✅ Upload complete. Starting OCR…');
      setStatus('processing');

      // ── Step 2: Send blob URL to server for OCR ──
      const body = {
        blobUrl,
        fileName: file.name,
        ...((!serverHasKey && apiKey.trim()) ? { apiKey: apiKey.trim() } : {}),
      };

      const res = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      // Handle non-JSON (e.g. Vercel timeout HTML page)
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Server error (${res.status}): response was not JSON. The PDF may be too large for the current plan's timeout.`);
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

      addLog(`✅ OCR complete — ${data.pageCount} page(s) processed.`);
      if (data.images.length > 0) addLog(`🖼  Extracted ${data.images.length} image(s).`);
      addLog('✨ Markdown ready!');

      setResult(data);
      setStatus('done');
    } catch (err) {
      addLog(`❌ ${err.message}`, 'error');
      setError(err.message);
      setStatus('error');
    }
  };

  const downloadMarkdown = () => {
    if (!result) return;
    const blob = new Blob([result.markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${result.fileName}.md`; a.click();
    URL.revokeObjectURL(url);
  };

  const downloadZip = async () => {
    if (!result) return;
    const zip = new JSZip();
    zip.file(`${result.fileName}.md`, result.markdown);

    if (result.images.length > 0) {
      const folder = zip.folder('images');
      addLog('📦 Fetching images for ZIP…');
      await Promise.all(result.images.map(async (img) => {
        try {
          const r = await fetch(img.url);
          const buf = await r.arrayBuffer();
          folder.file(img.name, buf);
        } catch (_) { /* skip failed images */ }
      }));
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${result.fileName}_ocr.zip`; a.click();
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    setFile(null); setStatus('idle'); setLogs([]);
    setResult(null); setError(''); setUploadProgress(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const renderMarkdown = (md) => {
    if (typeof window === 'undefined') return md;
    return md
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^#{6}\s(.+)$/gm, '<h6>$1</h6>')
      .replace(/^#{5}\s(.+)$/gm, '<h5>$1</h5>')
      .replace(/^#{4}\s(.+)$/gm, '<h4>$1</h4>')
      .replace(/^#{3}\s(.+)$/gm, '<h3>$1</h3>')
      .replace(/^#{2}\s(.+)$/gm, '<h2>$1</h2>')
      .replace(/^#{1}\s(.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^---$/gm, '<hr />')
      .replace(/!\[\[(.+?)\]\]/g, '<em class="img-ref">📎 $1</em>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\n/g, '<br />');
  };

  const isBusy = status === 'uploading' || status === 'processing';

  return (
    <>
      <Head>
        <title>PDF OCR → Markdown</title>
        <meta name="description" content="Convert PDFs to Markdown using Mistral OCR" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📄</text></svg>" />
      </Head>

      <div className="app">
        <header className="header">
          <div className="header-inner">
            <div className="logo">
              <span className="logo-icon">📄</span>
              <div>
                <h1>PDF OCR</h1>
                <p>Powered by Mistral AI</p>
              </div>
            </div>
            <div className="badge">✦ Obsidian-ready Markdown</div>
          </div>
        </header>

        <main className="main">
          <div className="card upload-card">
            <form onSubmit={handleSubmit}>
              {!serverHasKey && (
                <div className="field">
                  <label htmlFor="apiKey">Mistral API Key</label>
                  <input
                    id="apiKey" type="password"
                    placeholder="Enter your Mistral API key…"
                    value={apiKey} onChange={e => setApiKey(e.target.value)}
                    disabled={isBusy} autoComplete="off"
                  />
                  <span className="field-hint">Not stored — used only for this request.</span>
                </div>
              )}
              {serverHasKey && (
                <div className="api-badge">🔑 API key configured on server</div>
              )}

              <div
                className={`dropzone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                onClick={() => !isBusy && fileInputRef.current?.click()}
              >
                <input ref={fileInputRef} type="file" accept="application/pdf"
                  onChange={handleFileChange} style={{ display: 'none' }} />
                {file ? (
                  <div className="file-info">
                    <span className="file-icon">📑</span>
                    <div>
                      <strong>{file.name}</strong>
                      <span>{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                    </div>
                    <button type="button" className="remove-btn"
                      onClick={(e) => { e.stopPropagation(); setFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}>✕</button>
                  </div>
                ) : (
                  <div className="drop-prompt">
                    <span className="drop-icon">⬆</span>
                    <strong>Drop your PDF here</strong>
                    <span>or click to browse — up to 200 MB</span>
                  </div>
                )}
              </div>

              {/* Upload progress bar */}
              {status === 'uploading' && (
                <div className="progress-wrap">
                  <div className="progress-bar" style={{ width: `${uploadProgress}%` }} />
                  <span>{uploadProgress}% uploaded</span>
                </div>
              )}

              {error && <div className="error-msg">⚠ {error}</div>}

              <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={isBusy || !file}>
                  {status === 'uploading' ? <><span className="spinner" /> Uploading…</>
                    : status === 'processing' ? <><span className="spinner" /> Running OCR…</>
                    : '✦ Extract Markdown'}
                </button>
                {(status === 'done' || status === 'error') && (
                  <button type="button" className="btn-secondary" onClick={reset}>↺ New PDF</button>
                )}
              </div>
            </form>
          </div>

          {logs.length > 0 && (
            <div className="card logs-card">
              <h2 className="card-title">📋 Processing Log</h2>
              <div className="logs">
                {logs.map((l, i) => (
                  <div key={i} className={`log-line ${l.type}`}>
                    <span className="log-time">{l.time}</span>
                    <span>{l.msg}</span>
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>
          )}

          {result && (
            <div className="card result-card">
              <div className="result-header">
                <h2 className="card-title">✨ Result — {result.pageCount} page{result.pageCount !== 1 ? 's' : ''}</h2>
                <div className="result-actions">
                  <button className="btn-secondary" onClick={downloadMarkdown}>⬇ .md</button>
                  <button className="btn-primary" onClick={downloadZip}>
                    ⬇ ZIP{result.images.length > 0 ? ` (+${result.images.length} img)` : ''}
                  </button>
                </div>
              </div>

              <div className="tabs">
                {['preview', 'raw', ...(result.images.length > 0 ? ['images'] : [])].map(t => (
                  <button key={t} className={`tab ${activeTab === t ? 'active' : ''}`}
                    onClick={() => setActiveTab(t)}>
                    {t === 'preview' ? 'Preview' : t === 'raw' ? 'Raw Markdown' : `Images (${result.images.length})`}
                  </button>
                ))}
              </div>

              {activeTab === 'preview' && (
                <div className="markdown-preview"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(result.markdown) }} />
              )}

              {activeTab === 'raw' && (
                <div className="raw-container">
                  <button className="copy-btn"
                    onClick={() => navigator.clipboard.writeText(result.markdown)}>Copy</button>
                  <pre className="raw-markdown">{result.markdown}</pre>
                </div>
              )}

              {activeTab === 'images' && (
                <div className="images-grid">
                  {result.images.map((img, i) => (
                    <div key={i} className="image-item">
                      <img src={img.url} alt={img.name} loading="lazy" />
                      <span>{img.name}</span>
                      <a href={img.url} download={img.name} className="btn-secondary small">⬇ Save</a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </main>

        <footer className="footer">
          Built with <a href="https://mistral.ai" target="_blank" rel="noopener">Mistral OCR</a> · Outputs Obsidian-compatible Markdown
        </footer>
      </div>

      <style jsx global>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --bg: #0f0f13; --surface: #18181f; --surface2: #22222c; --border: #2e2e3a;
          --accent: #7c6af7; --accent2: #a78bfa; --text: #e8e8f0; --muted: #8888a0;
          --success: #34d399; --error: #f87171; --radius: 12px; --shadow: 0 4px 24px rgba(0,0,0,.4);
        }
        html { font-size: 16px; }
        body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; min-height: 100vh; }
        a { color: var(--accent2); text-decoration: none; }
        a:hover { text-decoration: underline; }
        .app { display: flex; flex-direction: column; min-height: 100vh; }
        .header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 1rem 1.5rem; }
        .header-inner { max-width: 860px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; }
        .logo { display: flex; align-items: center; gap: .75rem; }
        .logo-icon { font-size: 2rem; }
        .logo h1 { font-size: 1.25rem; font-weight: 700; }
        .logo p { font-size: .75rem; color: var(--muted); }
        .badge { background: linear-gradient(135deg,#7c6af722,#a78bfa22); border: 1px solid #7c6af755; color: var(--accent2); padding: .3rem .8rem; border-radius: 99px; font-size: .75rem; font-weight: 600; }
        .main { flex: 1; max-width: 860px; margin: 0 auto; width: 100%; padding: 2rem 1.5rem; display: flex; flex-direction: column; gap: 1.5rem; }
        .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.75rem; box-shadow: var(--shadow); }
        .card-title { font-size: 1rem; font-weight: 600; margin-bottom: 1.25rem; }
        .field { display: flex; flex-direction: column; gap: .4rem; margin-bottom: 1rem; }
        .field label { font-size: .85rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
        .field input { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: .65rem 1rem; color: var(--text); font-size: .95rem; transition: border-color .2s; }
        .field input:focus { outline: none; border-color: var(--accent); }
        .field-hint { font-size: .75rem; color: var(--muted); }
        .api-badge { background: #34d39915; border: 1px solid #34d39940; color: var(--success); padding: .5rem 1rem; border-radius: 8px; font-size: .85rem; margin-bottom: 1rem; }
        .dropzone { border: 2px dashed var(--border); border-radius: var(--radius); padding: 2.5rem; text-align: center; cursor: pointer; transition: all .2s; margin-bottom: 1rem; }
        .dropzone:hover, .dropzone.dragging { border-color: var(--accent); background: #7c6af710; }
        .dropzone.has-file { border-style: solid; border-color: var(--accent); background: #7c6af710; }
        .drop-prompt { display: flex; flex-direction: column; align-items: center; gap: .5rem; }
        .drop-icon { font-size: 2.5rem; }
        .drop-prompt strong { font-size: 1rem; }
        .drop-prompt span { font-size: .85rem; color: var(--muted); }
        .file-info { display: flex; align-items: center; gap: 1rem; justify-content: center; }
        .file-icon { font-size: 1.75rem; }
        .file-info div { display: flex; flex-direction: column; text-align: left; }
        .file-info span { font-size: .8rem; color: var(--muted); }
        .remove-btn { background: none; border: 1px solid var(--border); color: var(--muted); padding: .25rem .5rem; border-radius: 6px; cursor: pointer; font-size: .9rem; transition: all .2s; }
        .remove-btn:hover { border-color: var(--error); color: var(--error); }
        /* Progress bar */
        .progress-wrap { background: var(--surface2); border-radius: 8px; overflow: hidden; height: 8px; margin-bottom: .75rem; position: relative; }
        .progress-bar { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); transition: width .3s ease; border-radius: 8px; }
        .progress-wrap span { position: absolute; right: 0; top: 10px; font-size: .75rem; color: var(--muted); }
        .form-actions { display: flex; gap: .75rem; flex-wrap: wrap; margin-top: .25rem; }
        .btn-primary { background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #fff; border: none; padding: .7rem 1.5rem; border-radius: 8px; font-size: .95rem; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: .5rem; transition: opacity .2s; }
        .btn-primary:hover:not(:disabled) { opacity: .9; }
        .btn-primary:disabled { opacity: .4; cursor: not-allowed; }
        .btn-secondary { background: var(--surface2); color: var(--text); border: 1px solid var(--border); padding: .7rem 1.5rem; border-radius: 8px; font-size: .95rem; font-weight: 600; cursor: pointer; transition: border-color .2s; text-decoration: none; display: inline-flex; align-items: center; }
        .btn-secondary:hover { border-color: var(--accent); text-decoration: none; }
        .btn-secondary.small { padding: .3rem .75rem; font-size: .8rem; }
        .spinner { width: 14px; height: 14px; border: 2px solid #fff4; border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; display: inline-block; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .error-msg { background: #f8717115; border: 1px solid #f8717140; color: var(--error); padding: .6rem 1rem; border-radius: 8px; font-size: .9rem; margin-bottom: 1rem; }
        .logs { background: #0a0a0f; border-radius: 8px; padding: 1rem; font-family: 'SF Mono','Fira Code',monospace; font-size: .82rem; max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: .3rem; }
        .log-line { display: flex; gap: .75rem; }
        .log-time { color: var(--muted); flex-shrink: 0; }
        .log-line.error { color: var(--error); }
        .result-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .75rem; margin-bottom: 1.25rem; }
        .result-actions { display: flex; gap: .5rem; }
        .tabs { display: flex; gap: .25rem; margin-bottom: 1.25rem; border-bottom: 1px solid var(--border); padding-bottom: .75rem; }
        .tab { background: none; border: 1px solid transparent; color: var(--muted); padding: .4rem .9rem; border-radius: 8px; font-size: .875rem; font-weight: 500; cursor: pointer; transition: all .2s; }
        .tab:hover { color: var(--text); border-color: var(--border); }
        .tab.active { background: var(--surface2); border-color: var(--accent); color: var(--accent2); }
        .markdown-preview { background: var(--surface2); border-radius: 8px; padding: 1.5rem; line-height: 1.8; font-size: .95rem; max-height: 600px; overflow-y: auto; }
        .markdown-preview h1 { font-size: 1.6rem; margin: 1rem 0 .5rem; color: var(--accent2); }
        .markdown-preview h2 { font-size: 1.3rem; margin: 1rem 0 .5rem; }
        .markdown-preview h3 { font-size: 1.1rem; margin: .75rem 0 .4rem; }
        .markdown-preview hr { border: none; border-top: 1px solid var(--border); margin: 1rem 0; }
        .markdown-preview code { background: #0a0a0f; padding: .15rem .4rem; border-radius: 4px; font-family: monospace; font-size: .875em; color: var(--accent2); }
        .img-ref { color: var(--muted); font-style: normal; background: #7c6af715; padding: .1rem .4rem; border-radius: 4px; font-size: .85em; }
        .raw-container { position: relative; }
        .copy-btn { position: absolute; top: .75rem; right: .75rem; background: var(--surface); border: 1px solid var(--border); color: var(--muted); padding: .25rem .75rem; border-radius: 6px; font-size: .8rem; cursor: pointer; transition: all .2s; z-index: 1; }
        .copy-btn:hover { color: var(--text); border-color: var(--accent); }
        .raw-markdown { background: var(--surface2); border-radius: 8px; padding: 1.25rem; font-size: .82rem; font-family: 'SF Mono','Fira Code',monospace; max-height: 600px; overflow: auto; white-space: pre-wrap; word-break: break-word; line-height: 1.6; color: var(--muted); }
        .images-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px,1fr)); gap: 1rem; }
        .image-item { background: var(--surface2); border-radius: 8px; padding: .75rem; display: flex; flex-direction: column; gap: .5rem; align-items: center; }
        .image-item img { width: 100%; border-radius: 4px; max-height: 160px; object-fit: contain; }
        .image-item span { font-size: .75rem; color: var(--muted); text-align: center; word-break: break-all; }
        .footer { text-align: center; padding: 1.5rem; color: var(--muted); font-size: .8rem; border-top: 1px solid var(--border); }
        @media (max-width: 600px) {
          .header-inner { flex-direction: column; gap: .75rem; align-items: flex-start; }
          .result-header { flex-direction: column; align-items: flex-start; }
          .dropzone { padding: 1.5rem; }
        }
      `}</style>
    </>
  );
}
