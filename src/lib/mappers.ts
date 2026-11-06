/** Row → API shape mappers (snake_case DB → camelCase JSON the website expects). */

export type SystemRow = {
  slug: string;
  category: string;
  icon: string;
  name: string;
  short: string;
  description: string;
  intro: string;
  tags: string[];
  platforms: string[];
  specs: unknown;
  demo_message: string | null;
  featured: boolean;
  published: boolean;
  sort: number;
  created_at: Date;
  updated_at: Date;
};

export const mapSystem = (r: SystemRow) => ({
  slug: r.slug,
  category: r.category,
  icon: r.icon,
  name: r.name,
  short: r.short,
  description: r.description,
  intro: r.intro,
  tags: r.tags,
  platforms: r.platforms,
  specs: r.specs,
  demoMessage: r.demo_message,
  featured: r.featured,
  published: r.published,
  sort: r.sort,
  createdAt: r.created_at.toISOString().slice(0, 10),
  updatedAt: r.updated_at.toISOString(),
});
