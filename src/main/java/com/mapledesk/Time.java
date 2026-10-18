package com.mapledesk;

import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;

public final class Time {
  private static final DateTimeFormatter ISO =
      new DateTimeFormatterBuilder().appendInstant(3).toFormatter();

  private Time() {}

  public static String iso(Instant value) {
    return ISO.format(value);
  }
}
