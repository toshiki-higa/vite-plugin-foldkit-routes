import type { View } from './route.gen.ts';

export const view: View = (_input, h) =>
  h.section(
    [],
    [
      h.h1([], ['Hello Foldkit']),
      h.p([], ['This page comes from src/routes/page.ts.']),
      h.p([], ['Add a page.ts under src/routes to create another route.']),
    ],
  );
