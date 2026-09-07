This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Database

The schema lives in `supabase/`. One rule:

```bash
npm run db:check
```

**A database change is not finished until that passes.** It asks the running
database what exists and fails if anything is declared nowhere in the repo.

It matters because it was not always true. A 2026-09-06 audit found twelve
indexes and forty of ninety-nine functions live in production and recorded
nowhere — `resolve_session` and `_admin_actor` among them. A rebuild from the
repo would not have been slow; it would not have authenticated anybody. Objects
added through the Supabase dashboard never pass through a file, and nothing was
comparing the two.

The baseline migration has not been created yet — it needs the database
password, which is deliberately not in `.env.local`. See
[`supabase/migrations/README.md`](supabase/migrations/README.md) for the two
commands.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
