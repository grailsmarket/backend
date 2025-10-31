# Grails Backend Documentation Site

Static documentation site for the Grails ENS marketplace backend services, built with Astro.

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev
# Visit http://localhost:4321

# Build for production
npm run build

# Preview production build
npm run preview
```

## What's Documented

This site covers all four backend services:

- **API Service**: REST API with SIWE auth, Elasticsearch search, OpenSea integration
- **Indexer Service**: Blockchain event monitoring for ENS and marketplace events
- **WAL Listener Service**: PostgreSQL logical replication and Elasticsearch sync
- **Workers Service**: Asynchronous job processing with pg-boss

## Project Structure

```
src/
├── content/          # MDX documentation files
│   ├── overview/     # System architecture and quick start
│   ├── api/          # API service docs
│   ├── indexer/      # Indexer service docs
│   ├── wal-listener/ # WAL Listener service docs
│   └── workers/      # Workers service docs
├── components/       # Reusable Astro components
│   ├── Callout.astro      # Info/warning/error callouts
│   ├── CodeBlock.astro    # Code blocks with titles
│   └── APIEndpoint.astro  # API endpoint documentation
├── layouts/          # Page layouts
│   └── BaseLayout.astro   # Main layout with sidebar nav
├── pages/            # Route pages
│   ├── index.astro        # Homepage
│   ├── overview/[...slug].astro
│   ├── api/[...slug].astro
│   ├── indexer/[...slug].astro
│   ├── wal-listener/[...slug].astro
│   └── workers/[...slug].astro
└── styles/           # Global styles
    └── global.css    # Tailwind + custom styles
```

## Tech Stack

- **Astro**: Static site generator with content collections
- **MDX**: Markdown with React components
- **Tailwind CSS**: Utility-first styling
- **TypeScript**: Type-safe configuration

## Adding New Documentation

### 1. Create MDX File

Add a new `.mdx` file in the appropriate content directory:

```mdx
---
title: "Your Page Title"
description: "Brief description"
order: 1
---

import Callout from '../../components/Callout.astro';

# Your Page Title

Your content here...

<Callout type="info" title="Note">
  Important information
</Callout>
```

### 2. Use Components

Available components:

**Callout**:
```mdx
<Callout type="info|warning|success|error" title="Optional Title">
  Content goes here
</Callout>
```

**CodeBlock**:
```mdx
<CodeBlock title="Optional Title">
\`\`\`typescript
// Your code
\`\`\`
</CodeBlock>
```

**APIEndpoint**:
```mdx
<APIEndpoint
  method="GET"
  path="/api/v1/names"
  auth={true}
  description="Fetch ENS names"
>
  Additional details...
</APIEndpoint>
```

### 3. Navigation

The sidebar navigation is defined in `src/layouts/BaseLayout.astro`. Add new links as needed.

## Styling

The site uses a dark theme with CSS variables defined in `src/styles/global.css`:

- `--bg-primary`: Main background (#0a0a0a)
- `--bg-secondary`: Card/sidebar background (#1a1a1a)
- `--bg-tertiary`: Code block background (#2a2a2a)
- `--text-primary`: Main text color (white)
- `--text-secondary`: Secondary text (#a0a0a0)
- `--accent`: Purple accent color (#8b5cf6)
- `--border`: Border color (#333333)

## Deployment

### Local Docker

```bash
# Using Docker Compose (recommended)
docker-compose up -d

# Or using Docker directly
docker build -t grails-docs .
docker run -d -p 8080:80 grails-docs
```

Visit http://localhost:8080

### Railway

1. **Connect your repository** to Railway
2. **Select the service** directory: `services/docs`
3. Railway will **automatically detect** the Dockerfile and deploy
4. The site will be available at your Railway-provided URL

**Configuration:**
- Railway automatically sets the `PORT` environment variable
- The nginx config adapts to the provided port
- Health checks are configured in `railway.json`

**Manual Railway CLI deployment:**
```bash
cd services/docs
railway login
railway link
railway up
```

### Static Hosting Platforms

The site is static and can be deployed to any hosting platform:

**Vercel**:
```bash
npm run build
# Deploy dist/ directory
```

**Netlify**:
```bash
npm run build
# Deploy dist/ directory
```

**GitHub Pages**:
```bash
npm run build
# Deploy dist/ directory to gh-pages branch
```

### Container Platforms

The Dockerfile works with any Docker-compatible platform:

- **Render**: Detects Dockerfile automatically
- **Fly.io**: `fly launch` in the docs directory
- **Google Cloud Run**: `gcloud run deploy`
- **AWS App Runner**: Deploy from container registry
- **Azure Container Apps**: Deploy from registry

All platforms that provide a `PORT` environment variable will work automatically.

## Development

### Hot Reload

The development server watches for file changes and automatically rebuilds:

```bash
npm run dev
```

Edit any `.mdx`, `.astro`, or `.css` file and see changes instantly.

### Content Collections

Content is organized using Astro's content collections, configured in `src/content/config.ts`. This provides:

- Type-safe frontmatter
- Automatic route generation
- Built-in validation

### Build Output

Production builds are optimized and output to `dist/`:

```bash
npm run build
# Outputs static HTML, CSS, JS to dist/
```

## Maintenance

### Keeping Docs in Sync

Documentation source files are located in each service's directory:

- `services/api/CLAUDE.md` → Detailed technical reference
- `services/api/README.md` → Quick start guide

This docs site **summarizes and organizes** that information for easy navigation.

### Updating Content

1. Update source README.md or CLAUDE.md files in service directories
2. Sync relevant changes to this docs site
3. Rebuild and redeploy

## Future Enhancements

- [ ] Search functionality (Pagefind integration)
- [ ] Dark/light theme toggle
- [ ] Copy code button for code blocks
- [ ] Table of contents for long pages
- [ ] Version selector for API changes
- [ ] Interactive API playground
