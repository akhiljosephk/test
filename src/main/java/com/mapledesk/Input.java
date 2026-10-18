package com.mapledesk;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.LocalDate;
import java.util.*;

public final class Input {
  private Input() {}

  public static String text(String value, int max, boolean required) {
    String v = value == null ? "" : value.trim();
    Settings.require(
        (!required || !v.isEmpty()) && v.length() <= max, "Required text is missing or too long");
    return v;
  }

  public static String uuid(String value) {
    try {
      return UUID.fromString(value).toString();
    } catch (Exception e) {
      throw new IllegalArgumentException("Invalid record ID");
    }
  }

  public static String date(String value) {
    try {
      Settings.require(value != null && value.matches("\\d{4}-\\d{2}-\\d{2}"), "Invalid date");
      return LocalDate.parse(value).toString();
    } catch (Exception e) {
      throw new IllegalArgumentException("Invalid calendar date");
    }
  }

  public static String choice(String value, List<String> choices, String fallback) {
    String v = value == null ? fallback : value;
    Settings.require(choices.contains(v), "Invalid selection");
    return v;
  }

  public static boolean email(String value) {
    return value != null
        && value.length() <= 254
        && value.matches("[^\\s@<>;,]+@[^\\s@<>;,]+\\.[^\\s@<>;,]+");
  }

  public static boolean phone(String value) {
    return value != null && value.matches("\\+[1-9]\\d{7,14}");
  }

  public static <T> T parse(Map<String, Object> body, Class<T> type) {
    try {
      return Json.MAPPER.convertValue(body, type);
    } catch (Exception e) {
      throw new IllegalArgumentException("Invalid request fields");
    }
  }

  public record Contact(
      String name,
      String email,
      String phone,
      String notes,
      @JsonProperty("email_consent") boolean emailConsent,
      @JsonProperty("whatsapp_consent") boolean whatsappConsent,
      @JsonProperty("opted_out") boolean optedOut,
      @JsonProperty("consent_note") String consentNote) {
    public Contact {
      name = text(name, 100, true);
      email = text(email, 254, false).toLowerCase(Locale.ROOT);
      phone = text(phone, 16, false);
      notes = text(notes, 3000, false);
      consentNote = text(consentNote, 500, false);
      Settings.require(email.isEmpty() || Input.email(email), "Enter a valid email address");
      Settings.require(
          phone.isEmpty() || Input.phone(phone), "Use E.164 phone format, e.g. +14165550123");
      Settings.require(!email.isEmpty() || !phone.isEmpty(), "Email or phone is required");
    }
  }

  public record Lead(
      Contact contact,
      @JsonProperty("insurance_type") String insuranceType,
      String status,
      String due,
      @JsonProperty("interval_days") int intervalDays,
      String channel) {
    public Lead {
      Objects.requireNonNull(contact, "Client is required");
      insuranceType = text(insuranceType, 80, true);
      status =
          choice(
              status,
              List.of("New enquiry", "Quote sent", "Awaiting reply", "Won", "Lost"),
              "New enquiry");
      due = date(due);
      Settings.require(
          intervalDays == 2 || intervalDays == 4, "Follow-up cadence must be 2 or 4 days");
      channel = choice(channel, List.of("email", "whatsapp"), "email");
      Settings.require(
          channel.equals("email") ? !contact.email().isEmpty() : !contact.phone().isEmpty(),
          "Preferred channel requires its contact address");
    }
  }

  public record Policy(
      @JsonProperty("contact_id") String contactId,
      String number,
      String insurer,
      @JsonProperty("insurance_type") String insuranceType,
      String effective,
      String expiry,
      String status) {
    public Policy {
      contactId = uuid(contactId);
      number = text(number, 100, true);
      insurer = text(insurer, 100, true);
      insuranceType = text(insuranceType, 80, true);
      effective = date(effective);
      expiry = date(expiry);
      Settings.require(
          expiry.compareTo(effective) >= 0, "Expiry must be on or after effective date");
      status = choice(status, List.of("Active", "Cancelled", "Expired"), "Active");
    }
  }

  public record Template(String name, String language, List<String> parameters) {}

  public record Message(
      String contactId,
      String channel,
      String text,
      String subject,
      String purpose,
      String leadId,
      String policyId,
      String reminderJobId,
      String event,
      Template template,
      String key) {
    public Message {
      contactId = uuid(contactId);
      channel = choice(channel, List.of("email", "whatsapp"), "email");
      text = Input.text(text, 4000, true);
      subject = Input.text(subject == null ? "Your insurance enquiry" : subject, 200, false);
      purpose = choice(purpose, List.of("reply", "followup", "reminder"), "reply");
      if (leadId != null) leadId = uuid(leadId);
      if (policyId != null) policyId = uuid(policyId);
      if (reminderJobId != null) reminderJobId = uuid(reminderJobId);
      if (event != null) event = choice(event, List.of("effective", "expiry"), "expiry");
      key = uuid(key);
    }
  }
}
