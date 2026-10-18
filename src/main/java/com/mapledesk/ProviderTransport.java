package com.mapledesk;

import java.io.IOException;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import org.springframework.stereotype.Component;

@Component
public class ProviderTransport {
  private final HttpClient client;

  public ProviderTransport() {
    var builder = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10));
    String proxy =
        System.getenv()
            .getOrDefault("HTTPS_PROXY", System.getenv().getOrDefault("https_proxy", ""));
    if (!proxy.isBlank()) {
      URI uri = URI.create(proxy);
      InetSocketAddress address =
          new InetSocketAddress(uri.getHost(), uri.getPort() < 0 ? 80 : uri.getPort());
      builder.proxy(
          new ProxySelector() {
            @Override
            public List<Proxy> select(URI target) {
              return List.of(
                  Set.of("localhost", "127.0.0.1", "::1").contains(target.getHost())
                      ? Proxy.NO_PROXY
                      : new Proxy(Proxy.Type.HTTP, address));
            }

            @Override
            public void connectFailed(URI uri, java.net.SocketAddress a, IOException e) {}
          });
      if (uri.getUserInfo() != null) {
        String[] parts = uri.getUserInfo().split(":", 2);
        builder.authenticator(
            new Authenticator() {
              @Override
              protected PasswordAuthentication getPasswordAuthentication() {
                return getRequestorType() == RequestorType.PROXY
                        && getRequestingHost().equals(uri.getHost())
                    ? new PasswordAuthentication(
                        parts[0], parts.length > 1 ? parts[1].toCharArray() : new char[0])
                    : null;
              }
            });
      }
    }
    client = builder.build();
  }

  public Map<String, Object> exchange(
      String url, String method, Map<String, String> headers, String body) {
    HttpResponse<String> response;
    try {
      var b = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(20));
      headers.forEach(b::header);
      b.method(
          method,
          body == null
              ? HttpRequest.BodyPublishers.noBody()
              : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
      response = client.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new Failure(
          "Provider operation interrupted; check its outcome", 0, method.equals("POST"));
    } catch (IOException e) {
      throw new Failure(
          "Provider connection failed; check connection and network policy",
          0,
          method.equals("POST"));
    }
    int status = response.statusCode();
    if (status < 200 || status >= 300)
      throw new Failure(
          "Provider request rejected (HTTP " + status + ")",
          status,
          status >= 500 && method.equals("POST"));
    try {
      return response.body().isBlank() ? new LinkedHashMap<>() : Json.read(response.body());
    } catch (Exception e) {
      throw new Failure("Invalid provider response", status, method.equals("POST"));
    }
  }

  public static class Failure extends RuntimeException {
    public final int status;
    public final boolean ambiguous;

    public Failure(String message, int status, boolean ambiguous) {
      super(message);
      this.status = status;
      this.ambiguous = ambiguous;
    }
  }

  public static String form(Map<String, ?> values) {
    return values.entrySet().stream()
        .map(
            e ->
                URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8)
                    + "="
                    + URLEncoder.encode(e.getValue().toString(), StandardCharsets.UTF_8))
        .collect(java.util.stream.Collectors.joining("&"));
  }
}
