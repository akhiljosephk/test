package com.mapledesk;

import java.nio.file.*;
import java.util.*;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication(
    exclude = {
      DataSourceAutoConfiguration.class,
      org.springframework.boot.autoconfigure.security.servlet.UserDetailsServiceAutoConfiguration
          .class
    })
@EnableScheduling
public class Application {
  public static Map<String, Object> dotenv() {
    Map<String, Object> values = new LinkedHashMap<>();
    Path file = Path.of(".env");
    if (!Files.exists(file)) return values;
    try {
      for (String line : Files.readAllLines(file)) {
        line = line.trim();
        if (line.isEmpty() || line.startsWith("#")) continue;
        int i = line.indexOf('=');
        if (i < 1) continue;
        String key = line.substring(0, i).trim(), v = line.substring(i + 1).trim();
        if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'")))
          v = v.substring(1, v.length() - 1);
        values.put(key, v);
      }
    } catch (Exception e) {
      throw new IllegalStateException("Cannot read .env", e);
    }
    return values;
  }

  public static void main(String[] args) throws Exception {
    String command =
        Arrays.stream(args)
            .filter(a -> a.startsWith("--app.command="))
            .map(a -> a.substring(14))
            .findFirst()
            .orElse("serve");
    if (!command.equals("serve")) {
      Cli.run(command, args);
      return;
    }
    SpringApplication app = new SpringApplication(Application.class);
    app.setDefaultProperties(dotenv());
    app.run(args);
  }

  @Bean
  Settings settings(Environment env) {
    return new Settings(env::getProperty);
  }

  @Bean
  Database database(Settings cfg) {
    return new Database(cfg);
  }
}
