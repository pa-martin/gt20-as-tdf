# GT20 privé et édition des GPX

Une trace importée garde son badge et sa géométrie. Dans l’éditeur,
**Enregistrer les informations** modifie le nom, la date, le type, le statut
ou le tour sans recalculer la trace. **Créer une copie à reconstruire**
ouvre un nouveau brouillon ; l’original reste intact.

## Points marquants

Ouvrir une étape existante dans l’éditeur. Ajouter un lieu par son kilomètre,
par clic sur le profil, ou avec **Choisir sur la carte**. Un clic doit être à
moins de 100 m du tracé ; sur une boucle, choisir le passage par son kilomètre.
Ces repères ne sont jamais des contraintes de routage.

L’altitude attendue reste une référence sourcée, pas une correction du profil.
Une absence d’altitude reste inconnue ; un écart supérieur à 100 m est signalé.
Si le tracé change volontairement, les repères sont conservés « à replacer »,
sans apparaître sur le profil actif.

## Préparer le catalogue local

Fournir les douze fichiers originaux nommés `step1.gpx` à `step12.gpx`.
Le fichier de lieux préparé est facultatif ; sans lui, aucun nom de ville
ou de col supplémentaire n’est inventé.

```bash
node scripts/prepare-gt20.js --sources /chemin/vers/les-gpx --landmarks /chemin/vers/waypoints-gt20.json
```

Le paquet est enregistré sous `data/catalogs/gt20-private/`, ou sous
`ETAPEFORGE_DATA_DIR` si défini, hors versionnement. La préparation vérifie
les empreintes des GPX quand un fichier de lieux est fourni.

Dans **Archives**, cliquer **Importer les 12 étapes**. L’import est atomique,
sans routeur ni appel altimétrique ; les altitudes viennent des GPX. Il ne
compte pas comme douze sorties personnelles. Un second import retrouve
l’édition sans doublon et sans recréer une étape supprimée.

La géométrie complète est conservée séparément des échantillons analytiques,
également pour les nouveaux imports GPX. Les anciens imports simplifiés ne
récupèrent pas leurs points perdus. Les segments peu détaillés restent tels
quels : aucune précision ni aucun virage n’est inventé. Les contrôles
techniques du paquet ne deviennent pas des lieux publics.

**Droits :** ces GPX fournis ne sont pas redistribuables sans autorisation
écrite. Ne pas les committer, publier ni joindre à une PR. Le catalogue et
ses copies restent privés ; la publication des douze étapes est différée.
La licence du logiciel ne remplace pas celles des GPX, d’OpenStreetMap ou
de l’IGN. Les annotations et la géométrie importées sont incluses dans la
sauvegarde portable ; celle-ci contient des données privées.
La restauration JSON accepte jusqu’à 100 Mio, après contrôle administrateur
en mode public. Au-delà, utiliser la sauvegarde SQLite de l’instance.
