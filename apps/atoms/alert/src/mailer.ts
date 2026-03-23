import { logger } from "@townops/shared-ts";
import { Resend } from "resend";

import { env } from "./env";

const mailer = new Resend(env.RESEND_API_KEY);

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

/**
 * Sends an email using Resend with raw HTML content.
 * @param to - The recipient's email address.
 * @param subject - The subject line of the email.
 * @param html - The HTML body of the email.
 */
export async function sendEmail({ to, subject, html }: SendEmailOptions) {
  try {
    const { data } = await mailer.emails.send({
      from: "TownOps <townops@resend.dev>",
      to: [to],
      subject: subject,
      html: html,
    });

    logger.info(
      { data: data, to: to, subject: subject },
      "Email sent successfully"
    );

    return data;
  } catch (error) {
    logger.error(
      { error: error, to: to, subject: subject },
      "Failed to send email"
    );
    throw error;
  }
}
