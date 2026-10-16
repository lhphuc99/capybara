export function GET(request: Request) {
  const via = new URL(request.url).searchParams.get('via') ?? 'fetch';
  return Response.json({ message: 'Hello from a Next.js route handler', via });
}

export async function POST(request: Request) {
  return Response.json({ received: await request.json() }, { status: 201 });
}
