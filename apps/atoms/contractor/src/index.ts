import { Scalar } from "@scalar/hono-api-reference";
import {
  captureHonoException,
  corsOrigins,
  honoLogger,
  initSentry,
  logger,
  workerAuth,
} from "@townops/shared-ts";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  describeRoute,
  openAPIRouteHandler,
  resolver,
  validator,
} from "hono-openapi";
import { cors } from "hono/cors";
import { z } from "zod/v4";

import { env } from "./env";
import * as contractorService from "./service";
import {
  categoryCodeSchema,
  contractorIdSchema,
  createContractorSchema,
  searchQuerySchema,
  sectorCodeSchema,
  updateContractorSchema,
} from "./validation-schemas";

const app = new Hono();

initSentry({ serviceName: "contractor-atom" });

function requiredContractorId(c: Context): string {
  const id = c.req.param("id");
  if (!id) throw new Error("Missing contractor id route parameter");
  return id;
}

const devOrigins = corsOrigins();
if (devOrigins) {
  app.use(
    "*",
    cors({
      origin: devOrigins,
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: ["Content-Length"],
      maxAge: 600,
      credentials: true,
    })
  );
}

app.onError((err, c) => {
  captureHonoException(err, c);
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[contractor atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

app.use("*", honoLogger());

// ─── /api/contractors/:id/categories ─────────────────────────────────────────

const categoriesRouter = new Hono()
  .get(
    "/",
    describeRoute({
      description: "List all categories for a contractor",
      responses: {
        200: {
          description: "Categories",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  categories: z.array(z.object({ categoryCode: z.string() })),
                })
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const id = requiredContractorId(c);
      const categories = await contractorService.getCategoriesByContractor(id);
      return c.json({ categories }, 200);
    }
  )
  .post(
    "/",
    describeRoute({
      description: "Add a category to a contractor",
      responses: {
        201: { description: "Category added" },
        409: { description: "Category already assigned" },
      },
    }),
    validator("json", categoryCodeSchema),
    async (c) => {
      const id = requiredContractorId(c);
      const { categoryCode } = c.req.valid("json");
      const row = await contractorService.addCategory(id, categoryCode);
      if (!row) return c.json({ message: "already assigned" }, 409);
      logger.info({ contractorId: id, categoryCode }, "category added");
      return c.json({ category: row }, 201);
    }
  )
  .delete(
    "/:code",
    describeRoute({
      description: "Remove a category from a contractor",
      responses: {
        200: { description: "Category removed" },
        404: { description: "Category not found" },
      },
    }),
    async (c) => {
      const id = requiredContractorId(c);
      const code = c.req.param("code");
      const row = await contractorService.removeCategory(id, code);
      if (!row) return c.json({ error: "not found" }, 404);
      logger.info({ contractorId: id, categoryCode: code }, "category removed");
      return c.json({ category: row }, 200);
    }
  );

// ─── /api/contractors/:id/sectors ────────────────────────────────────────────

const sectorsRouter = new Hono()
  .get(
    "/",
    describeRoute({
      description: "List all sectors for a contractor",
      responses: {
        200: {
          description: "Sectors",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  sectors: z.array(z.object({ sectorCode: z.string() })),
                })
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const id = requiredContractorId(c);
      const sectors = await contractorService.getSectorsByContractor(id);
      return c.json({ sectors }, 200);
    }
  )
  .post(
    "/",
    describeRoute({
      description: "Add a sector to a contractor",
      responses: {
        201: { description: "Sector added" },
        409: { description: "Sector already assigned" },
      },
    }),
    validator("json", sectorCodeSchema),
    async (c) => {
      const id = requiredContractorId(c);
      const { sectorCode } = c.req.valid("json");
      const row = await contractorService.addSector(id, sectorCode);
      if (!row) return c.json({ message: "already assigned" }, 409);
      logger.info({ contractorId: id, sectorCode }, "sector added");
      return c.json({ sector: row }, 201);
    }
  )
  .delete(
    "/:code",
    describeRoute({
      description: "Remove a sector from a contractor",
      responses: {
        200: { description: "Sector removed" },
        404: { description: "Sector not found" },
      },
    }),
    async (c) => {
      const id = requiredContractorId(c);
      const code = c.req.param("code");
      const row = await contractorService.removeSector(id, code);
      if (!row) return c.json({ error: "not found" }, 404);
      logger.info({ contractorId: id, sectorCode: code }, "sector removed");
      return c.json({ sector: row }, 200);
    }
  );

// ─── /api/contractors ─────────────────────────────────────────────────────────

const contractorsRouter = new Hono()
  .get(
    "/",
    describeRoute({
      description: "List all contractors with their categories and sectors",
      responses: {
        200: {
          description: "Contractor list",
          content: {
            "application/json": {
              schema: resolver(z.object({ contractors: z.array(z.any()) })),
            },
          },
        },
      },
    }),
    async (c: Context) => {
      const rows = await contractorService.getAllContractors();
      logger.info({ count: rows.length }, "all contractors retrieved");
      return c.json({ contractors: rows }, 200);
    }
  )
  .post(
    "/",
    describeRoute({
      description: "Create a new contractor",
      responses: {
        201: { description: "Contractor created" },
        400: { description: "Validation failed" },
      },
    }),
    validator("json", createContractorSchema),
    async (c) => {
      const body = c.req.valid("json");
      const contractor = await contractorService.createContractor(body);
      logger.info({ contractorId: contractor.id }, "contractor created");
      return c.json({ contractor }, 201);
    }
  )
  .get(
    "/search",
    describeRoute({
      description:
        "Search for active contractors by sector code and category code",
      responses: {
        200: {
          description: "Matching contractors",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  contractors: z.array(
                    z.object({
                      id: z.string(),
                      name: z.string(),
                      email: z.string(),
                      contactNum: z.string().nullable(),
                      isActive: z.boolean(),
                    })
                  ),
                })
              ),
            },
          },
        },
      },
    }),
    validator("query", searchQuerySchema),
    async (c) => {
      const { sectorCode, categoryCode } = c.req.valid("query");
      const results = await contractorService.searchContractors(
        sectorCode,
        categoryCode
      );
      logger.info(
        { sectorCode, categoryCode, count: results.length },
        "contractor search executed"
      );
      return c.json({ contractors: results }, 200);
    }
  )
  .get(
    "/:id",
    describeRoute({
      description: "Get contractor by ID, including categories and sectors",
      responses: {
        200: { description: "Contractor found" },
        404: { description: "Contractor not found" },
      },
    }),
    validator("param", z.object({ id: contractorIdSchema })),
    async (c) => {
      const { id } = c.req.valid("param");
      const contractor = await contractorService.getContractorById(id);
      if (!contractor) return c.json({ error: "not found" }, 404);
      logger.info({ contractorId: id }, "contractor retrieved");
      return c.json({ contractor }, 200);
    }
  )
  .put(
    "/:id",
    describeRoute({
      description: "Update contractor details",
      responses: {
        200: { description: "Contractor updated" },
        404: { description: "Contractor not found" },
      },
    }),
    validator("param", z.object({ id: contractorIdSchema })),
    validator("json", updateContractorSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const contractor = await contractorService.updateContractor(id, body);
      if (!contractor) return c.json({ error: "not found" }, 404);
      logger.info({ contractorId: id }, "contractor updated");
      return c.json({ contractor }, 200);
    }
  )
  .delete(
    "/:id",
    describeRoute({
      description:
        "Deactivate a contractor (soft delete — sets is_active=false)",
      responses: {
        200: { description: "Contractor deactivated" },
        404: { description: "Contractor not found" },
      },
    }),
    validator("param", z.object({ id: contractorIdSchema })),
    async (c) => {
      const { id } = c.req.valid("param");
      const contractor = await contractorService.deactivateContractor(id);
      if (!contractor) return c.json({ error: "not found" }, 404);
      logger.info({ contractorId: id }, "contractor deactivated");
      return c.json({ contractor }, 200);
    }
  )
  .route("/:id/categories", categoriesRouter)
  .route("/:id/sectors", sectorsRouter);

// ─── /internal/contractors (Worker-only, PRS-139) ────────────────────────────

const eligibleQuerySchema = z.object({
  category: z.string().min(1),
  sector: z.string().min(1),
});

const internalContractorsRouter = new Hono()
  .use("*", workerAuth(env.WORKER_SERVICE_TOKEN))
  .get(
    "/:id/contact",
    validator("param", z.object({ id: contractorIdSchema })),
    async (c) => {
      const contact = await contractorService.getContractorContact(
        c.req.valid("param").id
      );
      if (!contact) return c.json({ error: "not found" }, 404);
      return c.json({ contact }, 200);
    }
  )
  .get(
    "/eligible",
    describeRoute({
      description:
        "Active Contractors eligible for a Case's category and postal sector",
      responses: {
        200: {
          description: "Eligible contractors",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  contractors: z.array(
                    z.object({
                      id: z.string(),
                      name: z.string(),
                      isActive: z.boolean(),
                    })
                  ),
                })
              ),
            },
          },
        },
      },
    }),
    validator("query", eligibleQuerySchema),
    async (c) => {
      const { category, sector } = c.req.valid("query");
      const eligible = await contractorService.getEligibleContractors({
        category,
        sector,
      });
      logger.info(
        { category, sector, count: eligible.length },
        "eligible contractors looked up"
      );
      return c.json({ contractors: eligible }, 200);
    }
  );

// ─── App assembly ─────────────────────────────────────────────────────────────

const contractorAtomRoutes = app
  .get(
    "/health",
    describeRoute({
      description: "Service health check",
      responses: {
        200: {
          description: "Healthy",
          content: {
            "application/json": {
              schema: resolver(z.object({ status: z.string() })),
            },
          },
        },
      },
    }),
    async (c: Context) => {
      logger.info({ route: "/health" }, "health check verified");
      return c.json({ status: "healthy" }, 200);
    }
  )
  .route("/api/contractors", contractorsRouter)
  .route("/internal/contractors", internalContractorsRouter)
  .get(
    "/openapi",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "Contractor Atom API",
          version: "1.0.0",
          description:
            "Contractor management — search by sector/category, full CRUD, category and sector assignment",
        },
        servers: [
          { url: `http://localhost:${env.PORT}`, description: "Local Server" },
        ],
      },
    })
  )
  .get(
    "/scalar",
    Scalar({
      url: "/openapi",
      theme: "deepSpace",
    })
  );

export { app };
export type ContractorAtomType = typeof contractorAtomRoutes;
export default {
  port: env.PORT,
  fetch: app.fetch,
};
