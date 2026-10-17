import chalk from 'chalk';
import ora from 'ora';

export const logger = {
  info: (msg) => console.log(chalk.blue('ℹ ') + chalk.white(msg)),
  success: (msg) => console.log(chalk.green('✔ ') + chalk.greenBright(msg)),
  warn: (msg) => console.log(chalk.yellow('⚠ ') + chalk.yellow(msg)),
  error: (msg) => console.log(chalk.red('✖ ') + chalk.redBright(msg)),
  debug: (msg) => {
    if (process.env.DEBUG) {
      console.log(chalk.gray('⚙ [DEBUG] ' + msg));
    }
  },
  title: (msg) => console.log('\n' + chalk.bold.cyan(msg)),
  divider: () => console.log(chalk.gray('─'.repeat(60))),

  banner: () => {
    console.log(chalk.cyanBright(`
╔════════════════════════════════════════════════════════════╗
║               🎵  MediaServer Music CLI  🎵                 ║
║       Spotify Importer & Hi-Res Metadata Downloader        ║
╚════════════════════════════════════════════════════════════╝`));
  },

  spinner: (text) => {
    return ora({
      text,
      color: 'cyan'
    });
  }
};
