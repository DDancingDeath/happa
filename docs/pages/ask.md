# Ask

Part of the [owner guide](../owner-guide.md) (one file per page). Hindi: [ask.hi.md](ask.hi.md). The codes in brackets are spec IDs in [calculations.md](../calculations.md).

Type a short question, in English, Hinglish or Hindi: "aaj ki bikri", "Ramesh ka
baaki", "kul baaki", "chawal ka stock". The answer comes from the data already on
this phone (it works offline and needs no internet or online service) and always
equals the page it links to: today's sales, purchases or business expenses
(ASK-1), what one party owes or is owed (ASK-2), the total to receive and to pay
(ASK-3), and one item's stock (ASK-4). When a name matches more than one party or
item, Ask lists them instead.

**Item purchases and sales (ASK-5, ASK-6, #415).** Ask which kinds of an item were bought or sold, how
much and at what average rate: "lah kitna kharida ab tak", "pichle mahine chawal ki kharid",
"लाह की किस्में कितनी खरीदीं". Every item whose name has that word counts (Lah Kusmi, Rangeeni
Lah, लाह, लाख कदकी, old archived items and names typed on bills too; "lah" and "lakh" / "लाख" are
the same word here); a name that only starts the
same ("Lahsun") is listed as not counted. The period is today, this or last month, year or
financial year, from the start of last month or year till today ("pichle saal se ab tak"), or
all time ("ab tak", "till today"); without one it is this month. Sales work the same way:
"chawal kitna becha is mahine", "thok me chawal kitna becha" (wholesale only), "khudra" (retail
only). Name a party to see only its bills: "Ramesh se lah kitna kharida", "Ramesh ko kya kya
becha" (every item Ramesh bought). Group by party ("lah kisko becha", "party wise") or by month
("mahine wise", "har mahine"). Under each answer, the **Bills**, **Period** and **Group by** choices change it, and
the kind buttons turn kinds on or off (for example add one listed as not counted). Each
kind shows its kg, average rate (total amount ÷ total kg) and amount, plus the total after
labour, the same figures as Insights › Items, adding up to Money's purchases. **Excel**
saves a Summary sheet and one sheet per kind (bill no., date, kg, rate, amount, labour,
after labour, and a totals row); **CSV** saves the same sheets in one file. Excel works offline
too: the app keeps its own copy of the Excel writer on the phone. When the period goes back before the bills
on this phone, Ask says how many bills it would read and loads them only when you confirm
(once per session; the free limit is 50,000 reads a day for the whole shop). Meanwhile it shows
a **quick figure** for the kinds asked about (ASK-7): kg, average rate and amount per kind from
Insights › Seasons' stats, at once and with no bills read (a few reads, about one per kind and year).
It is kg × rate before labour, so it can differ a little from the bill-by-bill figure; it is not
shown for one party's bills or for a report by party or month.

**Managers** with Statements on see the same reports in kg and bill counts only (no amounts or
rates, no Excel), from the bills on their phone; a longer period needs the owner.
