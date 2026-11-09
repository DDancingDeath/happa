# Ask

Part of the [owner guide](../owner-guide.md) (one file per page). Hindi: [ask.hi.md](ask.hi.md). The codes in brackets are spec IDs in [calculations.md](../calculations.md).

Type a short question, in English, Hinglish or Hindi: "aaj ki bikri", "Ramesh ka
baaki", "kul baaki", "chawal ka stock". The answer comes from the data already on
this phone (it works offline and needs no internet or online service) and always
equals the page it links to: today's sales, purchases or business expenses
(ASK-1), what one party owes or is owed (ASK-2), the total to receive and to pay
(ASK-3), and one item's stock (ASK-4). When a name matches more than one party or
item, Ask lists them instead.

**Item purchases (owner only, ASK-5, #415).** Ask which kinds of an item were bought, how
much and at what average rate: "lah kitna kharida ab tak", "pichle mahine chawal ki kharid",
"लाह की किस्में कितनी खरीदीं". Every item whose name has that word counts (Lah Kusmi, Rangeeni
Lah, लाह, old archived items and names typed on bills too); a name that only starts the
same ("Lahsun") is listed as not counted. The period is today, this or last month, year or
financial year, or all time ("ab tak", "till today"); without one it is this month. Each
kind shows its kg, average rate (total amount ÷ total kg) and amount, plus the total after
labour, the same figures as Insights › Items, adding up to Money's purchases. **Excel**
saves a Summary sheet and one sheet per kind (bill no., date, kg, rate, amount, labour,
after labour, and a totals row); **CSV** saves the same sheets in one file, and is used when
Excel can't load (it needs the internet once). When the period goes back before the bills
on this phone, Ask says how many bills it would read and loads them only when you confirm
(once per session; the free limit is 50,000 reads a day for the whole shop).
