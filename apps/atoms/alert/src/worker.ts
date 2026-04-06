import { logger, rabbitmqClient, captureException } from "@townops/shared-ts";
import { z } from "zod/v4";

import db from "./database/db";
import { alerts } from "./database/schema";
import {
  getCaseOpenedEmail,
  getJobAssignedEmail,
  getCaseEscalatedEmail,
  getCaseNoAccessEmail,
  getJobCompletedEmail,
  getGenericAlertEmail,
} from "./email-templates";
import { sendEmail } from "./mailer";
import { alertPayloadSchema } from "./validation-schemas";

/**
 * Starts the alert queue worker.
 * Listens to the alert-queue for incoming alert messages.
 * Processes and dispatches alerts to the appropriate recipients.
 */
export function startAlertQueueWorker() {
  void (async () => {
    try {
      await rabbitmqClient.connect();
      logger.info("Alert Atom is listening to RabbitMQ alert-queue");

      await rabbitmqClient.consume(
        "alert-queue",
        async (msg) => {
          try {
            if (!msg.body) {
              logger.warn("Received empty AMQP message body");
              return;
            }

            const bodyStr =
              typeof msg.body === "string"
                ? msg.body
                : (msg.bodyString() ?? Buffer.from(msg.body).toString("utf8"));
            const raw = JSON.parse(bodyStr);
            const routingKey = msg.routingKey;
            if (routingKey === "sla.breached") {
              logger.info({ routingKey }, "Skipping non-alert event");
              return;
            }

            const payload = alertPayloadSchema.parse(raw);

            logger.info({ payload, routingKey }, "Processing alert trigger");

            const recipientId = payload.residentId || payload.recipientId;
            const caseId = payload.caseId;

            let title = "";
            let htmlContent = "";
            const p = { ...payload, caseId };

            switch (routingKey) {
              case "case.opened":
                title = "Case Opened";
                htmlContent = getCaseOpenedEmail(p);
                break;
              case "job.assigned":
                title = "Job Assigned";
                htmlContent = getJobAssignedEmail(p);
                break;
              case "case.escalated":
                title = "Case Escalated";
                htmlContent = getCaseEscalatedEmail(p);
                break;
              case "case.no_access":
                title = "Access Issue Encountered";
                htmlContent = getCaseNoAccessEmail(p);
                break;
              case "job.done":
                title = "Job Completed";
                htmlContent = getJobCompletedEmail(p);
                break;
              default:
                title = `Notification: ${routingKey}`;
                htmlContent = getGenericAlertEmail({
                  title,
                  message:
                    payload.message ||
                    "Something occurred concerning your case",
                });
            }

            if (recipientId && caseId) {
              // 1. Audit to alerts database log layout
              await db.insert(alerts).values({
                caseId,
                recipientId,
                channel: payload.channel,
                message: payload.message || title,
              });

              // 2. Dispatch Email Template securely
              if (payload.email) {
                await sendEmail({
                  to: payload.email,
                  subject: `TownOps: ${title}`,
                  html: htmlContent,
                });

                logger.info(
                  { recipientId, caseId },
                  "alert e-mail sent successfully"
                );
              }
            }
          } catch (err) {
            if (err instanceof z.ZodError || err instanceof SyntaxError) {
              logger.error(
                { err: err },
                "poison pill amqp message: invalid format. dropping to DLX"
              );
              captureException(err, { serviceName: "alert-atom-worker" });
              throw err;
            }

            logger.error(
              { err: err },
              "transient failure in alert processing. requeueing message..."
            );
            captureException(err, { serviceName: "alert-atom-worker" });
            await msg.nack(false, true);
          }
        },
        { exchangeName: "townops.events", routingKey: "#" }
      );
    } catch (e) {
      logger.error(
        { err: e },
        "alert atom failed to connect to rabbitmq worker loop"
      );
    }
  })();
}
