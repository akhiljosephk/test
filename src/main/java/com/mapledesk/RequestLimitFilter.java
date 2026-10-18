package com.mapledesk;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.*;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Order(-200)
public class RequestLimitFilter extends OncePerRequestFilter {
  public static class LimitExceeded extends IOException {}

  @Override
  protected void doFilterInternal(
      HttpServletRequest req, HttpServletResponse res, FilterChain chain)
      throws IOException, ServletException {
    if (req.getContentLengthLong() > 1048576) {
      SecurityConfig.error(res, 413, "Request is too large");
      return;
    }
    chain.doFilter(
        new HttpServletRequestWrapper(req) {
          private ServletInputStream stream;

          @Override
          public ServletInputStream getInputStream() throws IOException {
            if (stream == null) {
              ServletInputStream input = super.getInputStream();
              stream =
                  new ServletInputStream() {
                    long count;

                    @Override
                    public int read() throws IOException {
                      int v = input.read();
                      if (v != -1 && ++count > 1048576) throw new LimitExceeded();
                      return v;
                    }

                    @Override
                    public boolean isFinished() {
                      return input.isFinished();
                    }

                    @Override
                    public boolean isReady() {
                      return input.isReady();
                    }

                    @Override
                    public void setReadListener(ReadListener l) {
                      input.setReadListener(l);
                    }
                  };
            }
            return stream;
          }

          @Override
          public BufferedReader getReader() throws IOException {
            return new BufferedReader(
                new InputStreamReader(getInputStream(), java.nio.charset.StandardCharsets.UTF_8));
          }
        },
        res);
  }
}
