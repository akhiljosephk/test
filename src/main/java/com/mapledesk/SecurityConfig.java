package com.mapledesk;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.*;
import java.util.*;
import org.springframework.context.annotation.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.filter.OncePerRequestFilter;

@Configuration
public class SecurityConfig {
  public static String token(HttpServletRequest request) {
    if (request.getCookies() != null)
      for (var c : request.getCookies())
        if (c.getName().equals("md_session") && c.getValue().matches("[a-f0-9]{64}"))
          return c.getValue();
    return "";
  }

  static void error(HttpServletResponse response, int status, String message) throws IOException {
    response.setStatus(status);
    response.setContentType("application/json");
    response.setHeader("Cache-Control", "no-store");
    response.getWriter().write(Json.write(Json.map("error", message)));
  }

  @Bean
  @org.springframework.core.annotation.Order(1)
  SecurityFilterChain visualMockup(HttpSecurity http) throws Exception {
    return http.securityMatcher("/mockups/MapleDesk-Interactive.html")
        .authorizeHttpRequests(a -> a.anyRequest().permitAll())
        .build();
  }

  @Bean
  @org.springframework.core.annotation.Order(2)
  SecurityFilterChain security(HttpSecurity http, AuthService auth, Settings cfg) throws Exception {
    http.csrf(c -> c.disable()) // API filter below enforces the migrated session-bound token and
        // exact Origin contract.
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .requestCache(c -> c.disable())
        .formLogin(c -> c.disable())
        .httpBasic(c -> c.disable())
        .logout(c -> c.disable())
        .headers(
            h ->
                h.contentSecurityPolicy(
                    c ->
                        c.policyDirectives(
                            "default-src 'self'; script-src 'self'; style-src 'self'; img-src"
                                + " 'self' data:; connect-src 'self'; frame-ancestors 'none';"
                                + " form-action 'self'")))
        .authorizeHttpRequests(
            a ->
                a.requestMatchers("/api/login")
                    .permitAll()
                    .requestMatchers("/api/**")
                    .authenticated()
                    .anyRequest()
                    .permitAll())
        .exceptionHandling(
            e ->
                e.authenticationEntryPoint(
                    (req, res, ex) -> error(res, 401, "Sign in to continue")))
        .addFilterBefore(
            new OncePerRequestFilter() {
              @Override
              protected boolean shouldNotFilter(HttpServletRequest req) {
                return !req.getRequestURI().startsWith("/api/");
              }

              @Override
              protected void doFilterInternal(
                  HttpServletRequest req, HttpServletResponse res, FilterChain chain)
                  throws ServletException, IOException {
                res.setHeader("Cache-Control", "no-store");
                boolean write = !Set.of("GET", "HEAD", "OPTIONS").contains(req.getMethod());
                if (write && !cfg.origin().equals(req.getHeader("Origin"))) {
                  error(res, 403, "Request origin is not allowed");
                  return;
                }
                if (!req.getRequestURI().equals("/api/login")) {
                  var session = auth.session(token(req));
                  if (session == null) {
                    error(res, 401, "Sign in to continue");
                    return;
                  }
                  if (write
                      && !Crypto.equal(
                          Json.str(session, "csrf"),
                          Objects.toString(req.getHeader("X-CSRF-Token"), ""))) {
                    error(res, 403, "Security token expired. Reload and try again.");
                    return;
                  }
                  req.setAttribute("md.session", session);
                  SecurityContextHolder.getContext()
                      .setAuthentication(
                          UsernamePasswordAuthenticationToken.authenticated(
                              session.get("email"),
                              null,
                              List.of(new SimpleGrantedAuthority("ROLE_OWNER"))));
                }
                chain.doFilter(req, res);
              }
            },
            UsernamePasswordAuthenticationFilter.class);
    return http.build();
  }
}
