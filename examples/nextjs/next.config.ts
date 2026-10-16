import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Otherwise `next dev` writes an AGENTS.md into this example.
  agentRules: false,
};

export default nextConfig;
