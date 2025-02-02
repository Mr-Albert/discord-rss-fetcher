import { LiteClient, LiteDisharmonyClient, loadConfig, Logger } from "disharmony"
import Feed from "../models/feed"
import Guild from "../models/guild"
import RssFetcher, { getRssFetcher } from "../service/rss-reader/abstract/rss-fetcher"
import ArticlePoster from "./article-poster"
import Normalise from "../core/normaliser"

export default class FeedMonitor
{
    private maxHistoryCount = 100000
    private globalHistory: string[] = []
    public isLinkInGlobalHistory(link: string): boolean
    {
        return this.globalHistory.indexOf(Normalise.forCache(link)) > -1
    }
    private pushGlobalHistory(...links: string[]){
        const newLinks = links.map(x => Normalise.forCache(x)).filter(x => !this.isLinkInGlobalHistory(x))
        Array.prototype.push.apply(this.globalHistory, newLinks)
        this.globalHistory.splice(0, this.globalHistory.length - this.maxHistoryCount)
    }

    timeout(ms: number) { //pass a time in milliseconds to this function
        return new Promise(resolve => setTimeout(resolve, ms));
      }
    logStatement(statement:String)
      {
          console.log(`[MONITOR] [${new Date().toUTCString()}] ${statement}`)
      }
    public async beginMonitoring()
    {
        // See https://discord.js.org/#/docs/main/stable/typedef/Status
        while (this.client.djs.status !== 5)
            for (const djsGuild of this.client.djs.guilds.values())
            {
                const guild = new Guild(djsGuild)
                // Allow the event queue to clear before processing the next guild if no perms in this one
                if (!guild.hasPermissions(this.client.config.requiredPermissions))
                {
                    await new Promise((resolve) => setImmediate(resolve))
                    continue
                }

                await guild.loadDocument()
                const didPostNewArticle = await this.fetchAndProcessAllGuildFeeds(guild)
                await this.timeout(180000);

                if (didPostNewArticle)
                    await guild.save()
            }

        // Reaching this code means the above while loop exited, which means the bot disconnected
        // await Logger.debugLogError(`Feed monitor disconnected from Discord!`)
        await Logger.logEvent("FeedMonitorDisconnect")
        console.log(`[MONITOR] [${new Date().toUTCString()}]`+">>>Error<<<Feed monitor disconnected from Discord!");
        console.log(`[MONITOR] [${new Date().toUTCString()}]`+"--Event--FeedMonitorDisconnect");

        process.exit(1)
    }

    public async fetchAndProcessAllGuildFeeds(guild: Guild)
    {
        let didPostNewArticle = false
        for (const feed of guild.feeds)
            didPostNewArticle = await this.fetchAndProcessFeed(guild, feed) || didPostNewArticle

        return didPostNewArticle
    }

    public async fetchAndProcessFeed(guild: Guild, feed: Feed): Promise<boolean>
    {
        try
        {
            if (!guild.channels.has(feed.channelId))
                return false

            const articles = await this.rssFetcher.fetchArticles(feed.url)
            if (articles.length === 0)
                return false

            //const article = articles[0], link = article.link
            for (let i = articles.length-1; i >=0;--i ){
                if (!articles[i].link || feed.isLinkInHistory(articles[i].link))
                    {
                        // this.logStatement(`>>>EXCLUDED<<from local ${feed.url} link: ${(articles[i].link)}`);
                        continue;
                    }
                if(!feed.exclusiveFeed && this.isLinkInGlobalHistory(articles[i].link))
                    {
                        // this.logStatement(`>>>EXCLUDED<<from global ${feed.url} link: ${(articles[i].link)}`);
                        continue;
                    }
                feed.pushHistory(articles[i].link)
                if(feed.channelName!="all-work") //fix this magic value
                    this.pushGlobalHistory(articles[i].link)
                // this.logStatement(`>>>INCLUDED<< ${feed.url} link: ${(articles[i].link)} channel ${feed.channelName}`);

                await this.articlePoster.postArticle(guild, feed.channelId, articles[i], feed.roleId)
            }
            return true
        }
        catch (e)
        {
            this.logStatement(`>>>ERROR<<Error fetching feed ${feed.url} in guild ${guild.name}`+ e);

            return false
        }
    }

    constructor(
        private client: LiteClient,
        private rssFetcher: RssFetcher,
        private articlePoster: ArticlePoster,
    )
    { }
}

if (!module.parent)
{
    const configPath = process.argv[2]
    const config = loadConfig(undefined, configPath)
    const client = new LiteDisharmonyClient(config)
    const articlePoster = new ArticlePoster()
    const feedMonitor = new FeedMonitor(client, getRssFetcher(), articlePoster)
    client.login(config.token)
        .then(() => feedMonitor.beginMonitoring())
        .catch(async err =>
        {
            console.log(`[MONITOR] [${new Date().toUTCString()}]`+">>>ERROR<<Error initialising feed monitor"+ err);

            process.exit(1)
        })
}
