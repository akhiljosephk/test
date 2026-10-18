package com.mapledesk;

import java.net.URI;
import java.net.http.*;
import java.time.Duration;

public final class HealthProbe {
  public static void main(String[] args) {
    try {
      int status =
          HttpClient.newBuilder()
              .connectTimeout(Duration.ofSeconds(3))
              .build()
              .send(
                  HttpRequest.newBuilder(
                          URI.create(
                              "http://127.0.0.1:"
                                  + System.getenv().getOrDefault("PORT", "3000")
                                  + "/healthz"))
                      .timeout(Duration.ofSeconds(4))
                      .GET()
                      .build(),
                  HttpResponse.BodyHandlers.discarding())
              .statusCode();
      System.exit(status == 200 ? 0 : 1);
    } catch (Exception e) {
      System.exit(1);
    }
  }
}
