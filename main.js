const puppeteer = require('puppeteer');
const fs = require('fs');
const csv = require('csv-parser')
const {Client} = require('pg')
const { exec } = require("child_process");
let data = fs.readFileSync('selectors.json');
let selectors = JSON.parse(data);
const pgData = {
    host:'107.178.218.81',
    password:'linecon0',
    user:'postgres',
    database:'tejmkc',
    port:'5432'
}

async function navigator(options){
    const browser = await puppeteer.launch({
        headless:options.headless,
        args: [`--window-size=${1800},${1800}`,
            '--disable-features=IsolateOrigins',
            '--disable-site-isolation-trials',
            '-no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ DNT: "1" });
    await page.setViewport({
        width: 1800,
        height: 1000
    });

    return {
        page:page,
        browser:browser
    }
}

async function getCredentials(){
    const client = new Client(pgData);
    await client.connect();
    const user = (await client.query({
        text:'SELECT username, password FROM "Accounts" WHERE NOT paused ORDER BY last_active ASC LIMIT 1',
    })).rows[0]
    await client.query({
        text: 'UPDATE "Accounts" SET last_active=now() WHERE username=$1',
        values:[user['username']]
    });
    await client.end();
    return user
}

async function processSignIn(user, options){
    const url = "https://www.letterboxd.com/";
    let navigationController = await navigator(options);
    let page = navigationController.page;
    await page.goto(url);
    await page.waitForSelector(selectors.login.signInButton);
    await (await page.$(selectors.login.signInButton)).click();
    await (await page.$(selectors.login.username)).type(user['username']);
    await (await page.$(selectors.login.password)).type(user['password']);
    await (await page.$(selectors.login.continueSignInButton)).click();
    await page.waitForTimeout(5000);
    return navigationController
}

async function recentReviewsLinks(delay){
    let navigationController = await navigator({
        headless:true
    });
    let page = navigationController.page;
    await page.setDefaultNavigationTimeout(0);
    await page.waitForTimeout(delay*4000);
    await page.goto("https://www.letterboxd.com/films/");
    await page.waitForTimeout(1000);
    const elementHandles = await page.$$(selectors.mainFilms.justReviewedCard);
    const filmHrefs = await Promise.all(elementHandles.map(async handle => {
        return await((await handle.getProperty("href")).jsonValue());
    }));
    await navigationController.browser.close()
    return(filmHrefs);
}

async function farmLinks(){
    let start = Date.now();
    let hrefsMatrix = await Promise.all(Array(5).fill(0).map((_,i)=>{
        return recentReviewsLinks(i)
    }));
    let result = [...new Set(hrefsMatrix.reduce((a,b)=>a.concat(b)))];
    let profileLinks = result.map(link=>{
        let username = link.split("/")[3]
        return `https://letterboxd.com/${username}`
    });
    return {
        reviews:result,
        profiles:profileLinks
    }
}

async function processProfileLinks(authenticatedPage, urls){
    console.log("Processing profile links... ... ... ", urls.length, " left")
    if(urls.length <= 0){
        return authenticatedPage
    }
    let cn = "ajax-click-action button -small -follow js-button-follow";
    await authenticatedPage.goto(urls[urls.length-1]);
    await authenticatedPage.waitForTimeout(2000);
    await authenticatedPage.evaluate((cn)=>{
        let ele = document.getElementsByClassName(cn)[0];
        console.log(ele);
        ele.click();
    }, cn);
    await authenticatedPage.waitForTimeout(3000);
    return processProfileLinks(authenticatedPage, urls.slice(0, -1))
}

async function processReviewLinks(authenticatedPage, urls){
    console.log("Processing review links... ... ... ", urls.length, " left")
    if(urls.length <= 0){
        return authenticatedPage
    }
    let cn = "svg-action -like ajax-click-action";
    await authenticatedPage.goto(urls[urls.length-1]);
    await authenticatedPage.waitForTimeout(2000);
    await authenticatedPage.evaluate((cn)=>{
        let ele = document.getElementsByClassName(cn)[0];
        console.log(ele);
        ele.click();
    }, cn);
    await authenticatedPage.waitForTimeout(3000);
    return processReviewLinks(authenticatedPage, urls.slice(0, -1))
}

async function recentReviewsProcess(){
    let initTime = Date.now();
    try{
        console.log("Gathering credentials... ... ...")
        let credentials = await getCredentials();
        console.log(credentials);
        console.log("... ... ...Finished")
        console.log("Gathering links... ... ...")
        const links = await farmLinks();
        console.log("... ... ...Finished")
        console.log("Processing sign in... ... ...")
        let navigationController = await processSignIn(credentials, {
            headless:true
        });
        console.log("... ... ...Finished")
        let authenticatedPage = navigationController.page;
        authenticatedPage = await processProfileLinks(authenticatedPage, links.profiles);
        console.log("... ... ...Finished")
        authenticatedPage = await processReviewLinks(authenticatedPage, links.reviews);
        console.log("... ... ...Finished")
        console.log("Terminating browser... ... ...");
        navigationController.browser.close();
        console.log("... ... ...Finished");
    }
    catch(error){
        console.log("======= error halted process ======");
        console.log(error);
    }
    finally {
        exec("pkill chrome", (error, stdout, stderr) => {
            if (error) {
                console.log(`error: ${error.message}`);
                return;
            }
            if (stderr) {
                console.log(`stderr: ${stderr}`);
                return;
            }
            console.log(`stdout: ${stdout}`);
        });
        console.log("⌛ Execution took ", Date.now()-initTime, " ms! ⌛")
    }

}

async function getStatsForAccount(username, page, client){
    const url = `https://www.letterboxd.com/${username}`;
    await page.goto(url);
    await page.waitForSelector(selectors.stats.following);
    const followingCount = await page.evaluate((selector)=>{
        return document.querySelector(selector).innerHTML;
    }, selectors.stats.following);
    const followersCount = await page.evaluate((selector)=>{
        return document.querySelector(selector).innerHTML;
    }, selectors.stats.followers);
    console.log("User ", username, " currently has ", followersCount, " followers");
    await client.query({
        text:'INSERT INTO "FollowersSeries"(record, username, followers) VALUES(now(), $1, $2)',
        values:[username, followersCount]
    })
    await client.query({
        text:'INSERT INTO "FollowingSeries"(record, username, following) VALUES(now(), $1, $2)',
        values:[username, followingCount]
    })
    await client.query({
        text:'INSERT INTO "FollowingSeries"(record, username, following) VALUES(now(), $1, $2)',
        values:[username, followingCount]
    })
    await client.query({
        text:'UPDATE "Accounts" SET followers=$1, following=$2 WHERE username=$3',
        values:[followersCount, followingCount, username]
    })
    return page
}

async function getStatsForAccountBulk(bulk, client){
    let navigationController = await navigator({
        headless:true
    });
    let page = navigationController.page;
    for(let k=0; k<bulk.length; k++){
        page = await getStatsForAccount(bulk[k]['username'], page, client)
    }
    await navigationController.browser.close();
}

async function getStats(){
    const client = new Client(pgData);
    try{
        console.log("Gathering stats begins... ... ...")

        await client.connect();
        const accounts = (await client.query({
            text:'SELECT username FROM "Accounts"'
        })).rows;

        const splices = Math.ceil(accounts.length / 10);
        console.log("Will use ", splices, " browsers for gathering")
        let nonFlat = [];
        for(let i=0; i<splices; i++){
            nonFlat.push(accounts.splice(0, 10))
        }
        await Promise.all(nonFlat.map(bulk=>{
            return getStatsForAccountBulk(bulk, client)
        }))
        await client.end();
        console.log("... ... ...gathering stats finished")
    }
    catch(error){
        console.log("====Something went wrong with stats gathering!====")
        console.log(error)
    }
    finally {
        await client.end();
    }
}

async function getMaxFollowerDisparity(){
    const client = new Client(pgData);
    await client.connect();
    let account = (await client.query({
        text:'SELECT * FROM "Accounts" ORDER BY following-followers DESC LIMIT 1'
    })).rows[0];
    await client.end();
    return account;
}

async function getNames(url){
    let navigationController = await navigator({
        headless:true
    });
    let page = navigationController.page;
    await page.goto(url);
    let selector = '#content > div > div > section > table > tbody > tr > td.table-person > div > h3 > a'
    let nameHandles = await page.$$(selector);
    let names = await Promise.all(nameHandles.map(async handle=>{
        let property = await handle.getProperty('innerHTML');
        const innerHtml = await property.jsonValue();
        return innerHtml
    }));
    return names;
}

async function farmNames(options){
    const baseUrl = `https://www.letterboxd.com/${options.username}/`;
    const variableUrl = (options.realm === "followers") ? "followers" : "following";
    const url = baseUrl + variableUrl;
    let names = await Promise.all(Array(options.pages).fill("x").map((_,i)=>{
        return getNames(url+`/page/${i+1}`)
    }));
    return names;
}

async function purifyFollowsProcess(){
    let initTime = Date.now();
    try{
        let targetAccount = await getMaxFollowerDisparity();
        console.log(targetAccount)
        let followers = [];
        let following = [];
        let followerPages = Math.ceil(targetAccount['followers'] / 25);
        let followingPages = Math.ceil(targetAccount['following'] / 25);
        let names = await farmNames({
            realm: "following",
            pages: followingPages,
            username:targetAccount['username']
        })
        console.log(names);

    }
    catch(error){
        console.log("======= error halted process ======");
        console.log(error);
    }
    finally {
        console.log("⌛ Execution took ", Date.now()-initTime, " ms! ⌛")
    }
}

async function main(){
    await recentReviewsProcess();
    await getStats()
    return main();
    //await purifyFollowsProcess()
}

main().then(()=>{})


