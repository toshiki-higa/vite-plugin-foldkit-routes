import type { View } from './route.gen.ts';

export const view: View = (_input, h) =>
  h.section(
    [],
    [
      h.h1([], ['About']),
      h.p([], ['This page comes from src/routes/about/page.ts.']),
      h.p([], ['The generated app is connected to one native Foldkit Runtime.']),
    ],
  );
