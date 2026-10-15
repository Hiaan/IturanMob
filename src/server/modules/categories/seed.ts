import type { Db } from "../../db";
import { DEFAULT_CATEGORIES } from "./defaults";

/** Cria as categorias padrão para uma família (idempotente). */
export async function seedDefaultCategories(db: Db, householdId: string): Promise<void> {
  let order = 0;
  for (const cat of DEFAULT_CATEGORIES) {
    const category = await db.category.upsert({
      where: { householdId_kind_name: { householdId, kind: cat.kind, name: cat.name } },
      update: {},
      create: {
        householdId,
        name: cat.name,
        kind: cat.kind,
        icon: cat.icon,
        color: cat.color,
        isSystem: true,
        sortOrder: order++,
      },
    });
    let subOrder = 0;
    for (const sub of cat.subcategories) {
      await db.subcategory.upsert({
        where: { categoryId_name: { categoryId: category.id, name: sub.name } },
        update: {},
        create: {
          householdId,
          categoryId: category.id,
          name: sub.name,
          keywords: sub.keywords,
          sortOrder: subOrder++,
        },
      });
    }
  }
}
