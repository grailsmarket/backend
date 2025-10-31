import { defineCollection, z } from 'astro:content';

const docsCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    order: z.number().optional(),
  }),
});

export const collections = {
  'overview': docsCollection,
  'api': docsCollection,
  'indexer': docsCollection,
  'wal-listener': docsCollection,
  'workers': docsCollection,
};
