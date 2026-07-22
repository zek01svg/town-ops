import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import db from "../../src/database/db";
import {
  contractorCategories,
  contractorSectors,
  contractors,
} from "../../src/database/schema";
import * as contractorService from "../../src/service";

/**
 * Eligibility is a conjunction: active AND covering the Case's Maintenance
 * Category AND its Postal Sector. Each test below breaks exactly one of the
 * three so a single over-permissive clause cannot hide behind the others.
 */
describe("Contractor eligibility", () => {
  const category = "PL";
  const sector = "12";

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE ${contractors} RESTART IDENTITY CASCADE`
    );
  });

  async function seed({
    name,
    isActive = true,
    categoryCode = category,
    sectorCode = sector,
  }: {
    name: string;
    isActive?: boolean;
    categoryCode?: string;
    sectorCode?: string;
  }) {
    const contractor = await contractorService.createContractor({
      name,
      email: `${name.replace(/\s+/g, "-").toLowerCase()}@test.com`,
      isActive,
    });
    await db
      .insert(contractorCategories)
      .values({ contractorId: contractor.id, categoryCode });
    await db
      .insert(contractorSectors)
      .values({ contractorId: contractor.id, sectorCode });
    return contractor;
  }

  it("returns a Contractor that is active and covers both the Category and Sector", async () => {
    const eligible = await seed({ name: "Fully Covering" });

    const results = await contractorService.getEligibleContractors({
      category,
      sector,
    });

    expect(results.map((row: any) => row.id)).toEqual([eligible.id]);
  });

  it("excludes an inactive Contractor that otherwise covers everything", async () => {
    await seed({ name: "Deactivated", isActive: false });

    const results = await contractorService.getEligibleContractors({
      category,
      sector,
    });

    expect(results).toHaveLength(0);
  });

  it("excludes a Contractor covering the Sector but not the Category", async () => {
    await seed({ name: "Wrong Category", categoryCode: "LE" });

    const results = await contractorService.getEligibleContractors({
      category,
      sector,
    });

    expect(results).toHaveLength(0);
  });

  it("excludes a Contractor covering the Category but not the Sector", async () => {
    await seed({ name: "Wrong Sector", sectorCode: "99" });

    const results = await contractorService.getEligibleContractors({
      category,
      sector,
    });

    expect(results).toHaveLength(0);
  });

  it("returns each eligible Contractor exactly once despite multiple coverage rows", async () => {
    const contractor = await seed({ name: "Multi Coverage" });
    // Extra coverage rows must not multiply the Contractor through the joins.
    await db
      .insert(contractorCategories)
      .values({ contractorId: contractor.id, categoryCode: "LE" });
    await db
      .insert(contractorSectors)
      .values({ contractorId: contractor.id, sectorCode: "34" });

    const results = await contractorService.getEligibleContractors({
      category,
      sector,
    });

    expect(results).toHaveLength(1);
  });
});
