import { renderHealthPdf } from "@/server/pdf/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const pdf = await renderHealthPdf();
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "cache-control": "private, no-store",
    },
  });
}
