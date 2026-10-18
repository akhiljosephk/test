package com.mapledesk;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;

public final class Json {
  public static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();

  private Json() {}

  public static String write(Object value) {
    try {
      return MAPPER.writeValueAsString(value);
    } catch (Exception e) {
      throw new IllegalArgumentException("Cannot encode data", e);
    }
  }

  public static Map<String, Object> read(String text) {
    try {
      return MAPPER.readValue(text, new TypeReference<>() {});
    } catch (Exception e) {
      throw new IllegalArgumentException("Invalid JSON data");
    }
  }

  @SuppressWarnings("unchecked")
  public static Map<String, Object> obj(Object value) {
    return value instanceof Map<?, ?> ? (Map<String, Object>) value : new LinkedHashMap<>();
  }

  @SuppressWarnings("unchecked")
  public static List<Map<String, Object>> rows(Object value) {
    return value instanceof List<?> ? (List<Map<String, Object>>) value : List.of();
  }

  public static String str(Map<String, Object> value, String key) {
    Object v = value.get(key);
    return v == null ? "" : v.toString();
  }

  public static long number(Object value) {
    return value == null
        ? 0
        : value instanceof Number n ? n.longValue() : Long.parseLong(value.toString());
  }

  public static boolean bool(Object value) {
    return Boolean.TRUE.equals(value)
        || value instanceof Number n && n.intValue() != 0
        || "true".equals(value);
  }

  public static Map<String, Object> map(Object... pairs) {
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i < pairs.length; i += 2) m.put(pairs[i].toString(), pairs[i + 1]);
    return m;
  }
}
