import type { CodeLanguage } from '@fbrx/shared';

/**
 * The code lab's languages: a Rock, Paper, Scissors quick start for each, and how to run it outside FBRX (where to get
 * the tools and the commands to type). Every quick start plays the same game the same way, so they are easy to compare.
 */

export interface LangInfo {
  id: CodeLanguage;
  name: string;
  ext: string;
  /** File name of the quick start. */
  file: string;
  /** How FBRX can run it: in its network-blocked JavaScript sandbox, in Windows Sandbox, or not at all. */
  runs: 'here' | 'windows-sandbox' | 'outside';
  get: { label: string; url: string };
  steps: string[];
  commands: string[];
  starter: string;
}

const PS = `# Rock, Paper, Scissors in PowerShell
$choices = 'rock', 'paper', 'scissors'
$beats = @{ rock = 'scissors'; paper = 'rock'; scissors = 'paper' }
$score = @{ you = 0; computer = 0; ties = 0 }

while ($true) {
    $you = "$(Read-Host 'rock, paper or scissors? (q to quit)')".Trim().ToLower()
    if ($you -eq 'q') { break }
    if ($you -notin $choices) { Write-Host 'Pick rock, paper or scissors.'; continue }

    $computer = Get-Random -InputObject $choices
    Write-Host "Computer picked $computer."
    if ($you -eq $computer) {
        Write-Host "It's a tie!" -ForegroundColor Yellow
        $score.ties++
    } elseif ($beats[$you] -eq $computer) {
        Write-Host "$you beats $computer. You win!" -ForegroundColor Green
        $score.you++
    } else {
        Write-Host "$computer beats $you. Computer wins." -ForegroundColor Red
        $score.computer++
    }
}
Write-Host "Final score - You: $($score.you)  Computer: $($score.computer)  Ties: $($score.ties)"
`;

const PY = `# Rock, Paper, Scissors in Python
import random

choices = ["rock", "paper", "scissors"]
beats = {"rock": "scissors", "paper": "rock", "scissors": "paper"}
score = {"you": 0, "computer": 0, "ties": 0}

while True:
    you = input("rock, paper or scissors? (q to quit) ").strip().lower()
    if you == "q":
        break
    if you not in choices:
        print("Pick rock, paper or scissors.")
        continue

    computer = random.choice(choices)
    print(f"Computer picked {computer}.")
    if you == computer:
        print("It's a tie!")
        score["ties"] += 1
    elif beats[you] == computer:
        print(f"{you} beats {computer}. You win!")
        score["you"] += 1
    else:
        print(f"{computer} beats {you}. Computer wins.")
        score["computer"] += 1

print(f"Final score - You: {score['you']}  Computer: {score['computer']}  Ties: {score['ties']}")
`;

const JS = `// Rock, Paper, Scissors in JavaScript
// In FBRX: type your moves in the Input box under the editor (one per line), then press Run.
const choices = ['rock', 'paper', 'scissors'];
const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const score = { you: 0, computer: 0, ties: 0 };

let answer;
while ((answer = prompt('rock, paper or scissors? (q to quit)')) !== null) {
  const you = answer.trim().toLowerCase();
  if (you === 'q') break;
  if (!choices.includes(you)) {
    console.log('Pick rock, paper or scissors.');
    continue;
  }

  const computer = choices[Math.floor(Math.random() * choices.length)];
  console.log(\`Computer picked \${computer}.\`);
  if (you === computer) {
    console.log("It's a tie!");
    score.ties++;
  } else if (beats[you] === computer) {
    console.log(\`\${you} beats \${computer}. You win!\`);
    score.you++;
  } else {
    console.log(\`\${computer} beats \${you}. Computer wins.\`);
    score.computer++;
  }
}
console.log(\`Final score - You: \${score.you}  Computer: \${score.computer}  Ties: \${score.ties}\`);
`;

const TS = `// Rock, Paper, Scissors in TypeScript (Node.js)
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

type Choice = 'rock' | 'paper' | 'scissors';
const choices: Choice[] = ['rock', 'paper', 'scissors'];
const beats: Record<Choice, Choice> = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const isChoice = (s: string): s is Choice => (choices as string[]).includes(s);

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const score = { you: 0, computer: 0, ties: 0 };
  while (true) {
    const you = (await rl.question('rock, paper or scissors? (q to quit) ')).trim().toLowerCase();
    if (you === 'q') break;
    if (!isChoice(you)) {
      console.log('Pick rock, paper or scissors.');
      continue;
    }

    const computer = choices[Math.floor(Math.random() * choices.length)];
    console.log(\`Computer picked \${computer}.\`);
    if (you === computer) {
      console.log("It's a tie!");
      score.ties++;
    } else if (beats[you] === computer) {
      console.log(\`\${you} beats \${computer}. You win!\`);
      score.you++;
    } else {
      console.log(\`\${computer} beats \${you}. Computer wins.\`);
      score.computer++;
    }
  }
  rl.close();
  console.log(\`Final score - You: \${score.you}  Computer: \${score.computer}  Ties: \${score.ties}\`);
}

void main();
`;

const CS = `// Rock, Paper, Scissors in C# (.NET 6 or newer, top-level statements)
var choices = new[] { "rock", "paper", "scissors" };
var beats = new Dictionary<string, string> { ["rock"] = "scissors", ["paper"] = "rock", ["scissors"] = "paper" };
int you = 0, computer = 0, ties = 0;

while (true)
{
    Console.Write("rock, paper or scissors? (q to quit) ");
    var pick = Console.ReadLine()?.Trim().ToLower();
    if (pick is null || pick == "q") break;
    if (!beats.ContainsKey(pick)) { Console.WriteLine("Pick rock, paper or scissors."); continue; }

    var cpu = choices[Random.Shared.Next(choices.Length)];
    Console.WriteLine($"Computer picked {cpu}.");
    if (pick == cpu) { Console.WriteLine("It's a tie!"); ties++; }
    else if (beats[pick] == cpu) { Console.WriteLine($"{pick} beats {cpu}. You win!"); you++; }
    else { Console.WriteLine($"{cpu} beats {pick}. Computer wins."); computer++; }
}
Console.WriteLine($"Final score - You: {you}  Computer: {computer}  Ties: {ties}");
`;

const JAVA = `// Rock, Paper, Scissors in Java (save as Rps.java)
import java.util.Map;
import java.util.Random;
import java.util.Scanner;

public class Rps {
    public static void main(String[] args) {
        String[] choices = {"rock", "paper", "scissors"};
        Map<String, String> beats = Map.of("rock", "scissors", "paper", "rock", "scissors", "paper");
        int you = 0, computer = 0, ties = 0;
        Random random = new Random();
        Scanner in = new Scanner(System.in);

        while (true) {
            System.out.print("rock, paper or scissors? (q to quit) ");
            if (!in.hasNextLine()) break;
            String pick = in.nextLine().trim().toLowerCase();
            if (pick.equals("q")) break;
            if (!beats.containsKey(pick)) {
                System.out.println("Pick rock, paper or scissors.");
                continue;
            }

            String cpu = choices[random.nextInt(choices.length)];
            System.out.println("Computer picked " + cpu + ".");
            if (pick.equals(cpu)) {
                System.out.println("It's a tie!");
                ties++;
            } else if (beats.get(pick).equals(cpu)) {
                System.out.println(pick + " beats " + cpu + ". You win!");
                you++;
            } else {
                System.out.println(cpu + " beats " + pick + ". Computer wins.");
                computer++;
            }
        }
        System.out.println("Final score - You: " + you + "  Computer: " + computer + "  Ties: " + ties);
    }
}
`;

const GO = `// Rock, Paper, Scissors in Go
package main

import (
	"bufio"
	"fmt"
	"math/rand"
	"os"
	"strings"
)

func main() {
	choices := []string{"rock", "paper", "scissors"}
	beats := map[string]string{"rock": "scissors", "paper": "rock", "scissors": "paper"}
	you, computer, ties := 0, 0, 0
	in := bufio.NewScanner(os.Stdin)

	for {
		fmt.Print("rock, paper or scissors? (q to quit) ")
		if !in.Scan() {
			break
		}
		pick := strings.ToLower(strings.TrimSpace(in.Text()))
		if pick == "q" {
			break
		}
		if _, ok := beats[pick]; !ok {
			fmt.Println("Pick rock, paper or scissors.")
			continue
		}

		cpu := choices[rand.Intn(len(choices))]
		fmt.Printf("Computer picked %s.\\n", cpu)
		switch {
		case pick == cpu:
			fmt.Println("It's a tie!")
			ties++
		case beats[pick] == cpu:
			fmt.Printf("%s beats %s. You win!\\n", pick, cpu)
			you++
		default:
			fmt.Printf("%s beats %s. Computer wins.\\n", cpu, pick)
			computer++
		}
	}
	fmt.Printf("Final score - You: %d  Computer: %d  Ties: %d\\n", you, computer, ties)
}
`;

const RUST = `// Rock, Paper, Scissors in Rust (no extra crates needed)
use std::collections::HashMap;
use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let choices = ["rock", "paper", "scissors"];
    let beats: HashMap<&str, &str> = [("rock", "scissors"), ("paper", "rock"), ("scissors", "paper")].into_iter().collect();
    let (mut you, mut computer, mut ties) = (0, 0, 0);

    loop {
        print!("rock, paper or scissors? (q to quit) ");
        io::stdout().flush().unwrap();
        let mut line = String::new();
        if io::stdin().read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let pick = line.trim().to_lowercase();
        if pick == "q" {
            break;
        }
        if !beats.contains_key(pick.as_str()) {
            println!("Pick rock, paper or scissors.");
            continue;
        }

        // The clock's nanoseconds are random enough for a game.
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_nanos();
        let cpu = choices[(nanos % 3) as usize];
        println!("Computer picked {cpu}.");
        if pick == cpu {
            println!("It's a tie!");
            ties += 1;
        } else if beats[pick.as_str()] == cpu {
            println!("{pick} beats {cpu}. You win!");
            you += 1;
        } else {
            println!("{cpu} beats {pick}. Computer wins.");
            computer += 1;
        }
    }
    println!("Final score - You: {you}  Computer: {computer}  Ties: {ties}");
}
`;

const C = `/* Rock, Paper, Scissors in C */
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static const char *choices[] = {"rock", "paper", "scissors"};

static int index_of(const char *s) {
    for (int i = 0; i < 3; i++)
        if (strcmp(s, choices[i]) == 0) return i;
    return -1;
}

int main(void) {
    char line[64];
    int you = 0, computer = 0, ties = 0;
    srand((unsigned)time(NULL));

    for (;;) {
        printf("rock, paper or scissors? (q to quit) ");
        fflush(stdout);
        if (!fgets(line, sizeof line, stdin)) break;
        line[strcspn(line, "\\r\\n")] = '\\0';
        for (char *p = line; *p; p++) *p = (char)tolower((unsigned char)*p);
        if (strcmp(line, "q") == 0) break;

        int pick = index_of(line);
        if (pick < 0) {
            puts("Pick rock, paper or scissors.");
            continue;
        }
        int cpu = rand() % 3;
        printf("Computer picked %s.\\n", choices[cpu]);
        if (pick == cpu) {
            puts("It's a tie!");
            ties++;
        } else if ((pick + 2) % 3 == cpu) { /* rock > scissors, paper > rock, scissors > paper */
            printf("%s beats %s. You win!\\n", choices[pick], choices[cpu]);
            you++;
        } else {
            printf("%s beats %s. Computer wins.\\n", choices[cpu], choices[pick]);
            computer++;
        }
    }
    printf("Final score - You: %d  Computer: %d  Ties: %d\\n", you, computer, ties);
    return 0;
}
`;

const CPP = `// Rock, Paper, Scissors in C++17
#include <algorithm>
#include <array>
#include <cctype>
#include <iostream>
#include <map>
#include <random>
#include <string>

int main() {
    const std::array<std::string, 3> choices{"rock", "paper", "scissors"};
    const std::map<std::string, std::string> beats{{"rock", "scissors"}, {"paper", "rock"}, {"scissors", "paper"}};
    std::mt19937 rng{std::random_device{}()};
    std::uniform_int_distribution<int> pickOne(0, 2);
    int you = 0, computer = 0, ties = 0;
    std::string pick;

    while (std::cout << "rock, paper or scissors? (q to quit) " && std::getline(std::cin, pick)) {
        std::transform(pick.begin(), pick.end(), pick.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        if (pick == "q") break;
        if (!beats.count(pick)) {
            std::cout << "Pick rock, paper or scissors.\\n";
            continue;
        }

        const std::string& cpu = choices[pickOne(rng)];
        std::cout << "Computer picked " << cpu << ".\\n";
        if (pick == cpu) {
            std::cout << "It's a tie!\\n";
            ++ties;
        } else if (beats.at(pick) == cpu) {
            std::cout << pick << " beats " << cpu << ". You win!\\n";
            ++you;
        } else {
            std::cout << cpu << " beats " << pick << ". Computer wins.\\n";
            ++computer;
        }
    }
    std::cout << "Final score - You: " << you << "  Computer: " << computer << "  Ties: " << ties << "\\n";
}
`;

const RUBY = `# Rock, Paper, Scissors in Ruby
choices = %w[rock paper scissors]
beats = { "rock" => "scissors", "paper" => "rock", "scissors" => "paper" }
score = Hash.new(0)

loop do
  print "rock, paper or scissors? (q to quit) "
  line = gets
  break if line.nil?
  you = line.strip.downcase
  break if you == "q"
  unless choices.include?(you)
    puts "Pick rock, paper or scissors."
    next
  end

  computer = choices.sample
  puts "Computer picked #{computer}."
  if you == computer
    puts "It's a tie!"
    score[:ties] += 1
  elsif beats[you] == computer
    puts "#{you} beats #{computer}. You win!"
    score[:you] += 1
  else
    puts "#{computer} beats #{you}. Computer wins."
    score[:computer] += 1
  end
end
puts "Final score - You: #{score[:you]}  Computer: #{score[:computer]}  Ties: #{score[:ties]}"
`;

const BASH = `#!/usr/bin/env bash
# Rock, Paper, Scissors in Bash (works with the older bash on a Mac too)
choices=(rock paper scissors)
you=0; computer=0; ties=0

beats() { # does $1 beat $2?
  case "$1:$2" in
    rock:scissors|paper:rock|scissors:paper) return 0 ;;
    *) return 1 ;;
  esac
}

while read -r -p "rock, paper or scissors? (q to quit) " pick; do
  pick=$(printf '%s' "$pick" | tr '[:upper:]' '[:lower:]')
  case "$pick" in
    q) break ;;
    rock|paper|scissors) ;;
    *) echo "Pick rock, paper or scissors."; continue ;;
  esac

  cpu=\${choices[RANDOM % 3]}
  echo "Computer picked $cpu."
  if [ "$pick" = "$cpu" ]; then
    echo "It's a tie!"; ties=$((ties + 1))
  elif beats "$pick" "$cpu"; then
    echo "$pick beats $cpu. You win!"; you=$((you + 1))
  else
    echo "$cpu beats $pick. Computer wins."; computer=$((computer + 1))
  fi
done
echo "Final score - You: $you  Computer: $computer  Ties: $ties"
`;

const LUA = `-- Rock, Paper, Scissors in Lua
local choices = { "rock", "paper", "scissors" }
local beats = { rock = "scissors", paper = "rock", scissors = "paper" }
local score = { you = 0, computer = 0, ties = 0 }
math.randomseed(os.time())

while true do
  io.write("rock, paper or scissors? (q to quit) ")
  local line = io.read("*l")
  if not line then break end
  local you = line:lower():match("^%s*(.-)%s*$")
  if you == "q" then break end

  if not beats[you] then
    print("Pick rock, paper or scissors.")
  else
    local computer = choices[math.random(#choices)]
    print("Computer picked " .. computer .. ".")
    if you == computer then
      print("It's a tie!")
      score.ties = score.ties + 1
    elseif beats[you] == computer then
      print(you .. " beats " .. computer .. ". You win!")
      score.you = score.you + 1
    else
      print(computer .. " beats " .. you .. ". Computer wins.")
      score.computer = score.computer + 1
    end
  end
end
print(("Final score - You: %d  Computer: %d  Ties: %d"):format(score.you, score.computer, score.ties))
`;

const PHP = `<?php
// Rock, Paper, Scissors in PHP (run it from the command line)
$choices = ['rock', 'paper', 'scissors'];
$beats = ['rock' => 'scissors', 'paper' => 'rock', 'scissors' => 'paper'];
$score = ['you' => 0, 'computer' => 0, 'ties' => 0];

while (true) {
    echo 'rock, paper or scissors? (q to quit) ';
    $line = fgets(STDIN);
    if ($line === false) break;
    $you = strtolower(trim($line));
    if ($you === 'q') break;
    if (!isset($beats[$you])) {
        echo "Pick rock, paper or scissors.\\n";
        continue;
    }

    $computer = $choices[array_rand($choices)];
    echo "Computer picked $computer.\\n";
    if ($you === $computer) {
        echo "It's a tie!\\n";
        $score['ties']++;
    } elseif ($beats[$you] === $computer) {
        echo "$you beats $computer. You win!\\n";
        $score['you']++;
    } else {
        echo "$computer beats $you. Computer wins.\\n";
        $score['computer']++;
    }
}
echo "Final score - You: {$score['you']}  Computer: {$score['computer']}  Ties: {$score['ties']}\\n";
`;

const KOTLIN = `// Rock, Paper, Scissors in Kotlin
fun main() {
    val choices = listOf("rock", "paper", "scissors")
    val beats = mapOf("rock" to "scissors", "paper" to "rock", "scissors" to "paper")
    var you = 0
    var computer = 0
    var ties = 0

    while (true) {
        print("rock, paper or scissors? (q to quit) ")
        val pick = readlnOrNull()?.trim()?.lowercase() ?: break
        if (pick == "q") break
        if (pick !in beats) {
            println("Pick rock, paper or scissors.")
            continue
        }

        val cpu = choices.random()
        println("Computer picked $cpu.")
        when {
            pick == cpu -> { println("It's a tie!"); ties++ }
            beats[pick] == cpu -> { println("$pick beats $cpu. You win!"); you++ }
            else -> { println("$cpu beats $pick. Computer wins."); computer++ }
        }
    }
    println("Final score - You: $you  Computer: $computer  Ties: $ties")
}
`;

const SWIFT = `// Rock, Paper, Scissors in Swift
import Foundation

let choices = ["rock", "paper", "scissors"]
let beats = ["rock": "scissors", "paper": "rock", "scissors": "paper"]
var you = 0, computer = 0, ties = 0

while true {
    print("rock, paper or scissors? (q to quit) ", terminator: "")
    guard let line = readLine() else { break }
    let pick = line.trimmingCharacters(in: .whitespaces).lowercased()
    if pick == "q" { break }
    guard beats[pick] != nil else {
        print("Pick rock, paper or scissors.")
        continue
    }

    let cpu = choices.randomElement()!
    print("Computer picked \\(cpu).")
    if pick == cpu {
        print("It's a tie!"); ties += 1
    } else if beats[pick] == cpu {
        print("\\(pick) beats \\(cpu). You win!"); you += 1
    } else {
        print("\\(cpu) beats \\(pick). Computer wins."); computer += 1
    }
}
print("Final score - You: \\(you)  Computer: \\(computer)  Ties: \\(ties)")
`;

// Delayed expansion eats "!" in echo lines, so the batch version says "You win." instead of "You win!".
const BATCH = `@echo off
setlocal EnableDelayedExpansion
rem Rock, Paper, Scissors in a Windows batch file
set you=0
set computer=0
set ties=0

:loop
set "pick="
set /p "pick=rock, paper or scissors? (q to quit) "
if /i "!pick!"=="q" goto done
if /i not "!pick!"=="rock" if /i not "!pick!"=="paper" if /i not "!pick!"=="scissors" (
  echo Pick rock, paper or scissors.
  goto loop
)

set /a n=%random% %% 3
if !n!==0 set cpu=rock
if !n!==1 set cpu=paper
if !n!==2 set cpu=scissors
echo Computer picked !cpu!.
if /i "!pick!"=="!cpu!" (
  echo It's a tie.
  set /a ties+=1
  goto loop
)
set win=0
if /i "!pick!"=="rock" if "!cpu!"=="scissors" set win=1
if /i "!pick!"=="paper" if "!cpu!"=="rock" set win=1
if /i "!pick!"=="scissors" if "!cpu!"=="paper" set win=1
if !win!==1 (
  echo !pick! beats !cpu!. You win.
  set /a you+=1
) else (
  echo !cpu! beats !pick!. Computer wins.
  set /a computer+=1
)
goto loop

:done
echo Final score - You: %you%  Computer: %computer%  Ties: %ties%
endlocal
`;

export const LANGS: LangInfo[] = [
  {
    id: 'powershell',
    name: 'PowerShell',
    ext: 'ps1',
    file: 'rps.ps1',
    runs: 'windows-sandbox',
    get: { label: 'Built into Windows (PowerShell 7: aka.ms/powershell)', url: 'https://aka.ms/powershell' },
    steps: ['Save the file and choose Open in → PowerShell ISE, then press F5. Or:', 'Open PowerShell in the folder that has the file and run:'],
    commands: ['powershell -ExecutionPolicy Bypass -File .\\rps.ps1'],
    starter: PS,
  },
  {
    id: 'python',
    name: 'Python',
    ext: 'py',
    file: 'rps.py',
    runs: 'outside',
    get: { label: 'python.org (or "Python 3" in the Microsoft Store)', url: 'https://www.python.org/downloads/' },
    steps: ['Install Python 3 (tick "Add python.exe to PATH" in the installer).', 'Open a terminal in the folder that has the file and run:'],
    commands: ['python rps.py', '# on a Mac or Linux: python3 rps.py'],
    starter: PY,
  },
  {
    id: 'javascript',
    name: 'JavaScript',
    ext: 'js',
    file: 'rps.js',
    runs: 'here',
    get: { label: 'Any web browser', url: 'https://developer.mozilla.org/docs/Learn/JavaScript' },
    steps: ['FBRX runs it right here, in a sandbox with no network or file access.', 'Outside FBRX: open any browser tab, press F12, choose Console, paste the code and press Enter. The browser asks for each move.'],
    commands: [],
    starter: JS,
  },
  {
    id: 'typescript',
    name: 'TypeScript',
    ext: 'ts',
    file: 'rps.ts',
    runs: 'outside',
    get: { label: 'Node.js (LTS)', url: 'https://nodejs.org/' },
    steps: ['Install Node.js.', 'Open a terminal in the folder that has the file and run (tsx compiles and runs TypeScript in one step):'],
    commands: ['npx tsx rps.ts'],
    starter: TS,
  },
  {
    id: 'csharp',
    name: 'C#',
    ext: 'cs',
    file: 'rps.cs',
    runs: 'outside',
    get: { label: '.NET SDK', url: 'https://dotnet.microsoft.com/download' },
    steps: ['Install the .NET SDK (8 or newer).', 'Make a console project, put the code in Program.cs, and run it:'],
    commands: ['dotnet new console -n Rps', '# replace Rps\\Program.cs with this file, then:', 'cd Rps', 'dotnet run'],
    starter: CS,
  },
  {
    id: 'java',
    name: 'Java',
    ext: 'java',
    file: 'Rps.java',
    runs: 'outside',
    get: { label: 'Eclipse Temurin JDK', url: 'https://adoptium.net/' },
    steps: ['Install a JDK (17 or newer).', 'The file must be called Rps.java (the class name). Java runs a single file directly:'],
    commands: ['java Rps.java'],
    starter: JAVA,
  },
  {
    id: 'go',
    name: 'Go',
    ext: 'go',
    file: 'rps.go',
    runs: 'outside',
    get: { label: 'go.dev', url: 'https://go.dev/dl/' },
    steps: ['Install Go.', 'Open a terminal in the folder that has the file and run:'],
    commands: ['go run rps.go'],
    starter: GO,
  },
  {
    id: 'rust',
    name: 'Rust',
    ext: 'rs',
    file: 'rps.rs',
    runs: 'outside',
    get: { label: 'rustup', url: 'https://rustup.rs/' },
    steps: ['Install Rust with rustup (on Windows it offers to install the C++ build tools it needs).', 'Compile, then run the program:'],
    commands: ['rustc rps.rs', '.\\rps.exe   # on a Mac or Linux: ./rps'],
    starter: RUST,
  },
  {
    id: 'c',
    name: 'C',
    ext: 'c',
    file: 'rps.c',
    runs: 'outside',
    get: { label: 'MSYS2 (gcc for Windows); on a Mac: xcode-select --install', url: 'https://www.msys2.org/' },
    steps: ['Install a C compiler.', 'Compile, then run the program:'],
    commands: ['gcc rps.c -o rps', '.\\rps.exe   # on a Mac or Linux: ./rps'],
    starter: C,
  },
  {
    id: 'cpp',
    name: 'C++',
    ext: 'cpp',
    file: 'rps.cpp',
    runs: 'outside',
    get: { label: 'MSYS2 (g++ for Windows) or Visual Studio Build Tools', url: 'https://www.msys2.org/' },
    steps: ['Install a C++ compiler.', 'Compile, then run the program:'],
    commands: ['g++ -std=c++17 rps.cpp -o rps', '.\\rps.exe   # on a Mac or Linux: ./rps'],
    starter: CPP,
  },
  {
    id: 'ruby',
    name: 'Ruby',
    ext: 'rb',
    file: 'rps.rb',
    runs: 'outside',
    get: { label: 'RubyInstaller (Windows); Macs have Ruby already', url: 'https://rubyinstaller.org/' },
    steps: ['Install Ruby.', 'Open a terminal in the folder that has the file and run:'],
    commands: ['ruby rps.rb'],
    starter: RUBY,
  },
  {
    id: 'bash',
    name: 'Bash',
    ext: 'sh',
    file: 'rps.sh',
    runs: 'outside',
    get: { label: 'Built into macOS and Linux; on Windows use WSL (wsl --install) or Git Bash', url: 'https://learn.microsoft.com/windows/wsl/install' },
    steps: ['Open Terminal (Mac or Linux), WSL or Git Bash in the folder that has the file and run:'],
    commands: ['bash rps.sh'],
    starter: BASH,
  },
  {
    id: 'lua',
    name: 'Lua',
    ext: 'lua',
    file: 'rps.lua',
    runs: 'outside',
    get: { label: 'lua.org (Windows: winget install DEVCOM.Lua)', url: 'https://www.lua.org/download.html' },
    steps: ['Install Lua.', 'Open a terminal in the folder that has the file and run:'],
    commands: ['lua rps.lua'],
    starter: LUA,
  },
  {
    id: 'php',
    name: 'PHP',
    ext: 'php',
    file: 'rps.php',
    runs: 'outside',
    get: { label: 'windows.php.net (Mac: brew install php)', url: 'https://windows.php.net/download/' },
    steps: ['Install PHP and add it to PATH.', 'Open a terminal in the folder that has the file and run:'],
    commands: ['php rps.php'],
    starter: PHP,
  },
  {
    id: 'kotlin',
    name: 'Kotlin',
    ext: 'kt',
    file: 'rps.kt',
    runs: 'outside',
    get: { label: 'Kotlin command-line compiler (needs a JDK)', url: 'https://kotlinlang.org/docs/command-line.html' },
    steps: ['Install a JDK and the Kotlin compiler.', 'Compile to a jar, then run it:'],
    commands: ['kotlinc rps.kt -include-runtime -d rps.jar', 'java -jar rps.jar'],
    starter: KOTLIN,
  },
  {
    id: 'swift',
    name: 'Swift',
    ext: 'swift',
    file: 'rps.swift',
    runs: 'outside',
    get: { label: 'Xcode on a Mac, or swift.org for Windows and Linux', url: 'https://www.swift.org/install/' },
    steps: ['Install Swift.', 'Open a terminal in the folder that has the file and run:'],
    commands: ['swift rps.swift'],
    starter: SWIFT,
  },
  {
    id: 'batch',
    name: 'Batch',
    ext: 'bat',
    file: 'rps.bat',
    runs: 'windows-sandbox',
    get: { label: 'Built into Windows', url: 'https://learn.microsoft.com/windows-server/administration/windows-commands/windows-commands' },
    steps: ['Open Command Prompt in the folder that has the file and run:'],
    commands: ['rps.bat'],
    starter: BATCH,
  },
];

const BY_ID = new Map(LANGS.map((l) => [l.id, l]));
const BY_EXT = new Map(LANGS.map((l) => [l.ext, l]));
BY_EXT.set('cmd', BY_ID.get('batch')!);

export function langInfo(id: CodeLanguage): LangInfo {
  return BY_ID.get(id) ?? LANGS[0];
}

export function langForFile(name: string): LangInfo | null {
  return BY_EXT.get(name.split('.').pop()?.toLowerCase() ?? '') ?? null;
}

/** A first line for a new, empty file. */
export function blankFile(l: LangInfo): string {
  const c = ['python', 'powershell', 'ruby', 'bash'].includes(l.id) ? '#' : l.id === 'lua' ? '--' : l.id === 'batch' ? 'rem' : '//';
  if (l.id === 'php') return '<?php\n// Start here\n';
  if (l.id === 'batch') return '@echo off\nrem Start here\n';
  return `${c} Start here\n`;
}
