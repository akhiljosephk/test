package com.akhil.ipldashboard.data;


public class TestLogic {

    public static void main(String[] args) {
        reverse(321);
    }

    public static int reverse(int x) {
      
         int rem = x / 10;
         int rev=0;
         while(rem > 0){
             int mod = x % 10;
             rev = rev + (mod * 10);
         }


       
    }
    
}
