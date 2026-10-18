package com.mapledesk;

import org.springframework.dao.DataAccessException;
import org.springframework.http.*;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice
public class Errors {
  @ExceptionHandler(ApiException.class)
  public ResponseEntity<?> api(ApiException e) {
    return ResponseEntity.status(e.status()).body(Json.map("error", e.getMessage()));
  }

  @ExceptionHandler(IllegalArgumentException.class)
  public ResponseEntity<?> invalid(IllegalArgumentException e) {
    return ResponseEntity.badRequest().body(Json.map("error", e.getMessage()));
  }

  @ExceptionHandler(HttpMessageNotReadableException.class)
  public ResponseEntity<?> unreadable(HttpMessageNotReadableException e) {
    Throwable root = e;
    while (root.getCause() != null) root = root.getCause();
    return ResponseEntity.status(root instanceof RequestLimitFilter.LimitExceeded ? 413 : 400)
        .body(
            Json.map(
                "error",
                root instanceof RequestLimitFilter.LimitExceeded
                    ? "Request is too large"
                    : "Invalid JSON request"));
  }

  @ExceptionHandler(DataAccessException.class)
  public ResponseEntity<?> database(DataAccessException e) {
    String detail = e.getMostSpecificCause().getMessage();
    boolean conflict = detail != null && detail.contains("SQLITE_CONSTRAINT");
    return ResponseEntity.status(conflict ? 409 : 500)
        .body(
            Json.map(
                "error",
                conflict
                    ? "A client address or policy number already exists, or a linked record is"
                        + " invalid."
                    : "Database operation failed"));
  }

  @ExceptionHandler(ProviderTransport.Failure.class)
  public ResponseEntity<?> provider(ProviderTransport.Failure e) {
    return ResponseEntity.status(502).body(Json.map("error", e.getMessage()));
  }
}
