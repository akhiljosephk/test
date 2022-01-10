package com.akhil.ipldashboard.data;

import javax.sql.DataSource;

import com.akhil.ipldashboard.model.Match;

import org.springframework.batch.core.configuration.annotation.EnableBatchProcessing;
import org.springframework.batch.core.configuration.annotation.JobBuilderFactory;
import org.springframework.batch.core.configuration.annotation.StepBuilderFactory;
import org.springframework.batch.item.database.BeanPropertyItemSqlParameterSourceProvider;
import org.springframework.batch.item.database.JdbcBatchItemWriter;
import org.springframework.batch.item.database.builder.JdbcBatchItemWriterBuilder;
import org.springframework.batch.item.file.FlatFileItemReader;
import org.springframework.batch.item.file.builder.FlatFileItemReaderBuilder;
import org.springframework.batch.item.file.mapping.BeanWrapperFieldSetMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.ClassPathResource;

@Configuration
@EnableBatchProcessing
public class BatchConfig {

  @Autowired
  public JobBuilderFactory jobBuilderFactory;

  @Autowired
  public StepBuilderFactory stepBuilderFactory;



    private final String[] FIELD_NAMES = new String[]{
        "id","city","date","player_of_match","venue","team1","team2","toss_winner","toss_decision","winner","result","result_margin","eliminator","method","umpire1","umpire2"
    };


  @Bean
public FlatFileItemReader<MatchInput> reader() {
  return new FlatFileItemReaderBuilder<MatchInput>()
    .name("personItemReader")
    .resource(new ClassPathResource("match-data.csv"))
    .delimited()
    .names(FIELD_NAMES)
    .fieldSetMapper(new BeanWrapperFieldSetMapper<MatchInput>() {{
      setTargetType(MatchInput.class);
    }})
    .build();
}

@Bean
public MatchDataProcessor processor() {
  return new MatchDataProcessor();
}

@Bean
public JdbcBatchItemWriter<Match> writer(DataSource dataSource) {
  return new JdbcBatchItemWriterBuilder<Match>()
    .itemSqlParameterSourceProvider(new BeanPropertyItemSqlParameterSourceProvider<>())
    .sql("INSERT INTO match (id,city,date,player_of_match,venue,team1,team2,toss_winner,toss_decision,match_winner,result,result_margin,umpire2,umpire1) "+
     "VALUES (::id,:city,:date,:playerOfMatch,:venue,:team1,:team2,:tossWinner,:tossDecision,:matchWinner,:result,:resultMargin,:umpire2,:umpire1)")
    .dataSource(dataSource)
    .build();
}
    
}
