export default function handler(req, res) {
  const hasKey = !!process.env.MISTRAL_API_KEY;
  return res.status(200).json({ hasKey });
}
