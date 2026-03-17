import { describe, it, expect } from "vitest";

import {
  getCaseOpenedEmail,
  getJobAssignedEmail,
  getCaseEscalatedEmail,
  getCaseNoAccessEmail,
  getJobCompletedEmail,
  getGenericAlertEmail,
} from "../../src/email-templates";

describe("Email Templates", () => {
  const mockParams = {
    caseId: "123e4567-e89b-12d3-a456-426614174000",
    category: "Plumbing",
    contractor: "John Doe",
    description: "Leaking pipe in kitchen",
  };

  describe("getCaseOpenedEmail", () => {
    it("should return HTML template with provided values", () => {
      const html = getCaseOpenedEmail(mockParams);
      expect(html).toContain("<h1>Case Opened</h1>");
      expect(html).toContain(mockParams.caseId);
      expect(html).toContain(mockParams.category);
      expect(html).toContain(mockParams.contractor);
      expect(html).toContain(mockParams.description);
    });

    it("should return HTML template with fallback values", () => {
      const html = getCaseOpenedEmail({ caseId: mockParams.caseId });
      expect(html).toContain("General");
      expect(html).toContain("Unassigned");
      expect(html).toContain("No description provided");
    });
  });

  describe("getJobAssignedEmail", () => {
    it("should return HTML template with Case ID", () => {
      const html = getJobAssignedEmail(mockParams);
      expect(html).toContain("<h1>Job Assigned</h1>");
      expect(html).toContain(mockParams.caseId);
    });
  });

  describe("getCaseEscalatedEmail", () => {
    it("should return HTML template with Case ID", () => {
      const html = getCaseEscalatedEmail(mockParams);
      expect(html).toContain("<h1>Case Escalated</h1>");
      expect(html).toContain(mockParams.caseId);
    });
  });

  describe("getCaseNoAccessEmail", () => {
    it("should return HTML template with Case ID", () => {
      const html = getCaseNoAccessEmail(mockParams);
      expect(html).toContain("<h1>Access Issue Encountered</h1>");
      expect(html).toContain(mockParams.caseId);
    });
  });

  describe("getJobCompletedEmail", () => {
    it("should return HTML template with Case ID", () => {
      const html = getJobCompletedEmail(mockParams);
      expect(html).toContain("<h1>Job Completed</h1>");
      expect(html).toContain(mockParams.caseId);
    });
  });

  describe("getGenericAlertEmail", () => {
    it("should return HTML template with Title and Message", () => {
      const html = getGenericAlertEmail({
        title: "Test Alert",
        message: "Test Content",
      });
      expect(html).toContain("<h1>Test Alert</h1>");
      expect(html).toContain("<p>Test Content</p>");
    });
  });
});
