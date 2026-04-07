import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import db from "../../src/database/db";
import { contractors } from "../../src/database/schema";
import * as contractorService from "../../src/service";

describe("Contractor Service Integration Tests", () => {
  beforeEach(async () => {
    // Clean up database before each test
    await db.execute(
      sql`TRUNCATE TABLE ${contractors} RESTART IDENTITY CASCADE`
    );
  });

  describe("Contractor CRUD", () => {
    it("should create a new contractor", async () => {
      const newContractor = {
        name: "Test Contractor",
        email: "test@contractor.com",
        contactNum: "1234567890",
      };

      const created = await contractorService.createContractor(newContractor);
      expect(created.id).toBeDefined();
      expect(created.name).toBe(newContractor.name);
      expect(created.email).toBe(newContractor.email);
    });

    it("should get a contractor by id with its relations", async () => {
      // Arrange
      const c = await contractorService.createContractor({
        name: "Relation Test",
        email: "relation@test.com",
      });
      await contractorService.addCategory(c.id, "CAT1");
      await contractorService.addSector(c.id, "SEC1");

      // Act
      const result = await contractorService.getContractorById(c.id);

      // Assert
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Relation Test");
      expect(result?.categories).toHaveLength(1);
      expect(result?.categories[0].categoryCode).toBe("CAT1");
      expect(result?.sectors).toHaveLength(1);
      expect(result?.sectors[0].sectorCode).toBe("SEC1");
    });

    it("should return null for non-existent contractor", async () => {
      const result = await contractorService.getContractorById(
        "00000000-0000-0000-0000-000000000000"
      );
      expect(result).toBeNull();
    });

    it("should update a contractor", async () => {
      const c = await contractorService.createContractor({
        name: "Old Name",
        email: "old@email.com",
      });

      const updated = await contractorService.updateContractor(c.id, {
        name: "New Name",
      });
      expect(updated?.name).toBe("New Name");

      const fetched = await contractorService.getContractorById(c.id);
      expect(fetched?.name).toBe("New Name");
    });

    it("should deactivate a contractor", async () => {
      const c = await contractorService.createContractor({
        name: "To Deactivate",
        email: "deactivate@test.com",
      });

      await contractorService.deactivateContractor(c.id);
      const fetched = await contractorService.getContractorById(c.id);
      expect(fetched?.isActive).toBe(false);
    });
  });

  describe("Categories and Sectors", () => {
    it("should add and remove categories", async () => {
      const c = await contractorService.createContractor({
        name: "Category Test",
        email: "cat@test.com",
      });

      await contractorService.addCategory(c.id, "PLUMB");
      let cats = await contractorService.getCategoriesByContractor(c.id);
      expect(cats).toHaveLength(1);
      expect(cats[0].categoryCode).toBe("PLUMB");

      await contractorService.removeCategory(c.id, "PLUMB");
      cats = await contractorService.getCategoriesByContractor(c.id);
      expect(cats).toHaveLength(0);
    });

    it("should add and remove sectors", async () => {
      const c = await contractorService.createContractor({
        name: "Sector Test",
        email: "sec@test.com",
      });

      await contractorService.addSector(c.id, "NORTH");
      let sectors = await contractorService.getSectorsByContractor(c.id);
      expect(sectors).toHaveLength(1);
      expect(sectors[0].sectorCode).toBe("NORTH");

      await contractorService.removeSector(c.id, "NORTH");
      sectors = await contractorService.getSectorsByContractor(c.id);
      expect(sectors).toHaveLength(0);
    });
  });

  describe("Search", () => {
    it("should search contractors by sector and category", async () => {
      const c1 = await contractorService.createContractor({
        name: "C1",
        email: "c1@test.com",
      });
      const c2 = await contractorService.createContractor({
        name: "C2",
        email: "c2@test.com",
      });

      await contractorService.addSector(c1.id, "S1");
      await contractorService.addCategory(c1.id, "K1");

      await contractorService.addSector(c2.id, "S1");
      await contractorService.addCategory(c2.id, "K2");

      const results = await contractorService.searchContractors("S1", "K1");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("C1");
    });

    it("should not return inactive contractors in search", async () => {
      const c = await contractorService.createContractor({
        name: "Inactive",
        email: "inactive@test.com",
      });
      await contractorService.addSector(c.id, "S1");
      await contractorService.addCategory(c.id, "K1");
      await contractorService.deactivateContractor(c.id);

      const results = await contractorService.searchContractors("S1", "K1");
      expect(results).toHaveLength(0);
    });
  });
});
