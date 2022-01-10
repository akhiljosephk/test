package com.akhil.ipldashboard.data;


import java.time.LocalDate;

import com.akhil.ipldashboard.model.Match;

import org.springframework.batch.item.ItemProcessor;

public class MatchDataProcessor implements ItemProcessor<MatchInput, Match> {

        @Override
        public Match process(final MatchInput input) throws Exception {
          
            Match match = new Match();
            match.setId(Long.parseLong(input.getId()));
            match.setCity(input.getCity());
            match.setDate(LocalDate.parse(input.getDate()));
            match.setPlayerOfMatch(input.getPlayer_of_match());
            match.setVenue(input.getVenue());

            String firstInnings,secondInnings;

            if("bat".equals(input.getToss_winner())){
                firstInnings = input.getToss_winner();
                secondInnings = input.getToss_decision().equals(input.getTeam1())?
                input.getTeam2():input.getTeam1();
            }
            else{
                secondInnings = input.getToss_winner();
                firstInnings = input.getToss_decision().equals(input.getTeam1())?
                input.getTeam2():input.getTeam1();
            }

            match.setTeam1(firstInnings);
            match.setTeam2(secondInnings);

            match.setTossWinner(input.getToss_winner());
            match.setTossDecision(input.getToss_decision());
            match.setMatchWinner(input.getWinner());

            match.setResult(input.getResult());
            match.setResultMargin(input.getResult_margin());
            match.setUmpire1(input.getUmpire1());
            match.setUmpire2(input.getUmpire2());
        
      
            return match;
        }
    
}
